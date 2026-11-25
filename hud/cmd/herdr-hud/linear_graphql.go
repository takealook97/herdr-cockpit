package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

// linearGraphQLEndpoint is replaced by tests only; there is no env or flag override.
var linearGraphQLEndpoint = "https://api.linear.app/graphql"

const linearGraphQLPageLimit = 3

const linearIssuesQuery = `query HerdrHudIssues($after: String) {
  organization { urlKey }
  viewer {
    assignedIssues(first: 100, after: $after, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
      nodes { identifier title url priority dueDate updatedAt state { name type } project { name } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

const linearViewerQuery = `query HerdrHudViewer { viewer { id name organization { name urlKey } } }`

type linearGraphQLError struct {
	Message    string `json:"message"`
	Extensions struct {
		Code string `json:"code"`
		Type string `json:"type"`
	} `json:"extensions"`
}

func (e linearGraphQLError) isAuth() bool {
	text := strings.ToLower(e.Extensions.Code + " " + e.Extensions.Type)
	return strings.Contains(text, "authentication")
}

func (e linearGraphQLError) isForbidden() bool {
	message := strings.ToLower(e.Message)
	return strings.EqualFold(e.Extensions.Code, "FORBIDDEN") ||
		strings.Contains(message, "forbidden") || strings.Contains(message, "permission") ||
		strings.Contains(message, "scope") || strings.Contains(message, "not allowed")
}

// linearGraphQL posts one query. HTTP 401 and authentication errors in the
// errors envelope map to invalid_key. Issue detail also recognizes missing entities.
func linearGraphQL(ctx context.Context, key, query string, variables map[string]any, out any) error {
	raw, err := json.Marshal(map[string]any{"query": query, "variables": variables})
	if err != nil {
		return linearError(linearErrBadResponse)
	}
	ctx, cancel := context.WithTimeout(ctx, linearRequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, linearGraphQLEndpoint, bytes.NewReader(raw))
	if err != nil {
		return linearError(linearErrBadResponse)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", key)
	resp, err := linearClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := linearReadBody(resp.Body)
	if err != nil {
		return err
	}
	var envelope struct {
		Data   json.RawMessage      `json:"data"`
		Errors []linearGraphQLError `json:"errors"`
	}
	parsed := json.Unmarshal(body, &envelope) == nil
	for _, e := range envelope.Errors {
		if e.isAuth() {
			return linearError(linearErrInvalidKey)
		}
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return linearError(linearErrInvalidKey)
	case resp.StatusCode == http.StatusForbidden:
		return linearError(linearErrForbidden)
	case resp.StatusCode >= 500:
		return linearError(linearErrNetwork)
	}
	stateChange := query == linearCompleteQuery || query == linearUpdateStateMutation
	if parsed && stateChange {
		for _, e := range envelope.Errors {
			if e.isForbidden() {
				return linearError(linearErrForbidden)
			}
		}
	}
	if parsed && (query == linearIssueQuery || stateChange) {
		for _, e := range envelope.Errors {
			code := strings.ToUpper(e.Extensions.Code)
			if code == "ENTITY_NOT_FOUND" || code == "ISSUE_NOT_FOUND" || linearIssueMissing(e.Message) {
				return linearError(linearErrNotFound)
			}
		}
	}
	if resp.StatusCode != http.StatusOK || !parsed || len(envelope.Errors) > 0 || len(envelope.Data) == 0 {
		return linearError(linearErrBadResponse)
	}
	if json.Unmarshal(envelope.Data, out) != nil {
		return linearError(linearErrBadResponse)
	}
	return nil
}

// linearGraphQLViewer validates a key and returns nonsecret identity.
func linearGraphQLViewer(ctx context.Context, key string) (linearIdentity, error) {
	var data struct {
		Viewer *struct {
			ID           string `json:"id"`
			Name         string `json:"name"`
			Organization struct {
				Name   string `json:"name"`
				URLKey string `json:"urlKey"`
			} `json:"organization"`
		} `json:"viewer"`
	}
	if err := linearGraphQL(ctx, key, linearViewerQuery, map[string]any{}, &data); err != nil {
		return linearIdentity{}, err
	}
	if data.Viewer == nil || data.Viewer.ID == "" {
		return linearIdentity{}, linearError(linearErrInvalidKey)
	}
	return linearIdentity{UserName: data.Viewer.Name, OrgName: data.Viewer.Organization.Name, OrgURL: linearOrgURLFromKey(data.Viewer.Organization.URLKey)}, nil
}

// linearGraphQLIssues returns the pages already read with the error when a
// later page fails.
func linearGraphQLIssues(ctx context.Context, key string) (linearIssuesPayload, error) {
	out := linearIssuesPayload{Source: strPtr(linearSourceAPIKey), Issues: []linearIssue{}}
	var cursor *string
	for page := 0; page < linearGraphQLPageLimit; page++ {
		var data struct {
			Organization struct {
				URLKey string `json:"urlKey"`
			} `json:"organization"`
			Viewer *struct {
				AssignedIssues *struct {
					Nodes []struct {
						Identifier string  `json:"identifier"`
						Title      string  `json:"title"`
						URL        string  `json:"url"`
						Priority   float64 `json:"priority"`
						DueDate    *string `json:"dueDate"`
						UpdatedAt  string  `json:"updatedAt"`
						State      struct {
							Name string `json:"name"`
							Type string `json:"type"`
						} `json:"state"`
						Project *struct {
							Name string `json:"name"`
						} `json:"project"`
					} `json:"nodes"`
					PageInfo struct {
						HasNextPage bool   `json:"hasNextPage"`
						EndCursor   string `json:"endCursor"`
					} `json:"pageInfo"`
				} `json:"assignedIssues"`
			} `json:"viewer"`
		}
		if err := linearGraphQL(ctx, key, linearIssuesQuery, map[string]any{"after": cursor}, &data); err != nil {
			return out, err
		}
		if data.Viewer == nil || data.Viewer.AssignedIssues == nil {
			return out, linearError(linearErrBadResponse)
		}
		if url := linearOrgURLFromKey(data.Organization.URLKey); url != "" && out.OrgURL == nil {
			out.OrgURL = strPtr(url)
		}
		issues := data.Viewer.AssignedIssues
		for _, node := range issues.Nodes {
			var project *string
			if node.Project != nil {
				project = linearOptional(node.Project.Name)
			}
			issue, ok := linearNormalize(linearRawIssue{
				Identifier: node.Identifier, Title: node.Title, URL: node.URL, Status: node.State.Name, StatusType: node.State.Type,
				Priority: node.Priority, Project: project, DueDate: node.DueDate, UpdatedAt: node.UpdatedAt,
			})
			if ok {
				out.Issues = append(out.Issues, issue)
			}
		}
		if !issues.PageInfo.HasNextPage || issues.PageInfo.EndCursor == "" {
			break
		}
		next := issues.PageInfo.EndCursor
		cursor = &next
	}
	return out, nil
}

const linearIssueQuery = `query HerdrHudIssue($id: String!) {
  issue(id: $id) {
    identifier title description url priority dueDate updatedAt
    state { name type }
    project { name }
    team { key }
    assignee { name }
    labels(first: 20) { nodes { name } }
  }
}`

func linearGraphQLIssue(ctx context.Context, key, identifier string) (linearIssueDetail, error) {
	var data struct {
		Issue json.RawMessage `json:"issue"`
	}
	if err := linearGraphQL(ctx, key, linearIssueQuery, map[string]any{"id": identifier}, &data); err != nil {
		return linearIssueDetail{}, err
	}
	if string(data.Issue) == "null" {
		return linearIssueDetail{}, linearError(linearErrNotFound)
	}
	var node struct {
		Identifier  string
		Title       string
		Description *string
		URL         *string
		Priority    *float64
		DueDate     *string
		UpdatedAt   *string
		State       struct{ Name, Type string }
		Project     struct{ Name string }
		Team        struct{ Key string }
		Assignee    struct{ Name string }
		Labels      struct{ Nodes []struct{ Name string } }
	}
	if json.Unmarshal(data.Issue, &node) != nil {
		return linearIssueDetail{}, linearError(linearErrBadResponse)
	}
	out := linearIssueDetail{
		Identifier: node.Identifier, Title: node.Title, Description: node.Description, URL: node.URL,
		Priority: linearDetailPriority(node.Priority), DueDate: node.DueDate, UpdatedAt: node.UpdatedAt,
		Status: linearOptional(node.State.Name), StatusType: linearOptional(strings.ToLower(node.State.Type)),
		Project: linearOptional(node.Project.Name), TeamKey: linearOptional(node.Team.Key),
		Assignee: linearOptional(node.Assignee.Name),
	}
	for _, label := range node.Labels.Nodes {
		if label.Name != "" {
			out.Labels = append(out.Labels, label.Name)
		}
	}
	return out, nil
}
