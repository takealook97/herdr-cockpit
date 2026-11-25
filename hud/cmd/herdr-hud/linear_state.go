package main

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const linearErrNoDoneState = "no_done_state"

var linearStateUUIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type linearStatePayload struct {
	Source         *string `json:"source"`
	Identifier     *string `json:"identifier"`
	Status         *string `json:"status"`
	StatusType     *string `json:"status_type"`
	Previous       *string `json:"previous"`
	PreviousStatus *string `json:"previous_status"`
	Error          *string `json:"error"`
}

func linearValidStateToken(s string) bool {
	return len(s) > 0 && len(s) <= 64 && utf8.ValidString(s) &&
		strings.TrimSpace(s) == s && strings.IndexFunc(s, unicode.IsControl) == -1
}

func linearSetState(ctx context.Context, identifier string, restoreToken *string) (linearStatePayload, int) {
	unlock, err := linearCredentialLock(ctx)
	if err != nil {
		return linearStatePayload{Error: strPtr(linearErrBusy)}, 0
	}
	defer unlock()

	cred, code := linearResolve(ctx, time.Now())
	source := linearOptional(cred.Source)
	if code != "" {
		return linearStatePayload{Source: source, Error: strPtr(code)}, 0
	}
	var out linearStatePayload
	if cred.Source == linearSourceAPIKey {
		if restoreToken == nil {
			out, err = linearGraphQLComplete(ctx, cred.Secret, identifier)
		} else {
			if !linearStateUUIDPattern.MatchString(*restoreToken) {
				return linearStatePayload{Source: source, Error: strPtr(linearErrBadRequest)}, 2
			}
			out, err = linearGraphQLSetState(ctx, cred.Secret, identifier, *restoreToken)
		}
	} else {
		out, err = linearMCPChangeState(ctx, cred, identifier, restoreToken)
	}
	if err != nil {
		return linearStatePayload{Source: source, Error: strPtr(linearCode(err))}, 0
	}

	out.Source = source
	for _, field := range []*string{out.Source, out.Identifier, out.Status, out.StatusType, out.Previous, out.PreviousStatus} {
		if field != nil && cred.Secret != "" && strings.Contains(*field, cred.Secret) {
			return linearStatePayload{Error: strPtr(linearErrBadResponse)}, 0
		}
	}
	_ = linearRemoveIfPresent(linearCachePath())
	return out, 0
}

const linearCompleteQuery = `query HerdrHudCompleteState($id: String!) {
  issue(id: $id) {
    identifier
    state { id name type }
    team { states(filter: { type: { eq: "completed" } }) { nodes { id name position } } }
  }
}`

const linearUpdateStateMutation = `mutation HerdrHudUpdateState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
    issue { identifier state { id name type } }
  }
}`

type linearGraphQLStateIssue struct {
	Identifier string
	State      struct{ ID, Name, Type string }
}

func (issue linearGraphQLStateIssue) statePayload(identifier string) (linearStatePayload, error) {
	if issue.Identifier != identifier || !linearStateUUIDPattern.MatchString(issue.State.ID) ||
		issue.State.Name == "" || issue.State.Type == "" {
		return linearStatePayload{}, linearError(linearErrBadResponse)
	}
	return linearStatePayload{
		Identifier: strPtr(issue.Identifier), Status: strPtr(issue.State.Name),
		StatusType: strPtr(strings.ToLower(issue.State.Type)),
	}, nil
}

func linearGraphQLComplete(ctx context.Context, key, identifier string) (linearStatePayload, error) {
	var data struct {
		Issue json.RawMessage
	}
	if err := linearGraphQL(ctx, key, linearCompleteQuery, map[string]any{"id": identifier}, &data); err != nil {
		return linearStatePayload{}, err
	}
	if string(data.Issue) == "null" {
		return linearStatePayload{}, linearError(linearErrNotFound)
	}
	var issue struct {
		linearGraphQLStateIssue
		Team struct {
			States *struct {
				Nodes []struct {
					ID       string
					Position *float64
				}
			}
		}
	}
	if json.Unmarshal(data.Issue, &issue) != nil {
		return linearStatePayload{}, linearError(linearErrBadResponse)
	}
	out, err := issue.statePayload(identifier)
	if err != nil || strings.Contains(issue.State.Name, key) {
		return linearStatePayload{}, linearError(linearErrBadResponse)
	}
	if *out.StatusType != "completed" {
		states := issue.Team.States
		if states == nil {
			return linearStatePayload{}, linearError(linearErrBadResponse)
		}
		if len(states.Nodes) == 0 {
			return linearStatePayload{}, linearError(linearErrNoDoneState)
		}
		selected := states.Nodes[0]
		for _, state := range states.Nodes {
			if state.Position == nil || !linearStateUUIDPattern.MatchString(state.ID) {
				return linearStatePayload{}, linearError(linearErrBadResponse)
			}
			if *state.Position < *selected.Position {
				selected = state
			}
		}
		out, err = linearGraphQLSetState(ctx, key, identifier, selected.ID)
		if err != nil {
			return linearStatePayload{}, err
		}
		if *out.StatusType != "completed" {
			return linearStatePayload{}, linearError(linearErrBadResponse)
		}
	}
	out.Previous = strPtr(issue.State.ID)
	out.PreviousStatus = strPtr(issue.State.Name)
	return out, nil
}

func linearGraphQLSetState(ctx context.Context, key, identifier, stateID string) (linearStatePayload, error) {
	var data struct {
		IssueUpdate struct {
			Success bool
			Issue   linearGraphQLStateIssue
		}
	}
	vars := map[string]any{"id": identifier, "stateId": stateID}
	if err := linearGraphQL(ctx, key, linearUpdateStateMutation, vars, &data); err != nil {
		return linearStatePayload{}, err
	}
	if !data.IssueUpdate.Success || !strings.EqualFold(data.IssueUpdate.Issue.State.ID, stateID) {
		return linearStatePayload{}, linearError(linearErrBadResponse)
	}
	return data.IssueUpdate.Issue.statePayload(identifier)
}

func linearMCPChangeState(ctx context.Context, cred linearCred, identifier string, restoreToken *string) (linearStatePayload, error) {
	s, err := newMCPSession(cred)
	if err != nil {
		return linearStatePayload{}, err
	}
	if err := s.start(ctx); err != nil {
		return linearStatePayload{}, err
	}
	tools, err := s.tools(ctx)
	if err != nil {
		return linearStatePayload{}, err
	}
	get := tools["get_issue"].InputSchema.Properties
	save := tools["save_issue"].InputSchema.Properties
	if get["id"] == nil || save["id"] == nil || save["state"] == nil {
		return linearStatePayload{}, linearError(linearErrBadResponse)
	}

	state := "completed"
	if restoreToken != nil {
		state = *restoreToken
	}
	var previous *string
	if restoreToken == nil {
		current, err := s.readState(ctx, cred.Secret, identifier)
		if err != nil {
			return linearStatePayload{}, err
		}
		if !linearValidStateToken(*current.Status) {
			return linearStatePayload{}, linearError(linearErrBadResponse)
		}
		previous = current.Status
		if current.StatusType != nil && *current.StatusType == "completed" {
			current.Previous, current.PreviousStatus = previous, previous
			return current, nil
		}
	}

	if _, err := s.callTool(ctx, "save_issue", map[string]any{"id": identifier, "state": state}); err != nil {
		return linearStatePayload{}, err
	}
	out, err := s.readState(ctx, cred.Secret, identifier)
	if err != nil {
		return linearStatePayload{}, err
	}
	if restoreToken == nil && (out.StatusType == nil || *out.StatusType != "completed") {
		return linearStatePayload{}, linearError(linearErrBadResponse)
	}
	out.Previous, out.PreviousStatus = previous, previous
	return out, nil
}

func (s *mcpSession) readState(ctx context.Context, secret, identifier string) (linearStatePayload, error) {
	issue, err := s.readIssue(ctx, identifier)
	if err != nil {
		return linearStatePayload{}, err
	}
	if issue.Identifier != identifier || issue.Title == "" || issue.Status == nil ||
		issue.StatusType == nil || issue.containsSecret(secret) {
		return linearStatePayload{}, linearError(linearErrBadResponse)
	}
	return linearStatePayload{
		Identifier: strPtr(issue.Identifier), Status: issue.Status, StatusType: linearOptional(*issue.StatusType),
	}, nil
}
