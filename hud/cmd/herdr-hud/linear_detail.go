package main

import (
	"context"
	"math"
	"regexp"
	"strings"
	"time"
)

const (
	linearErrBadRequest        = "bad_request"
	linearErrNotFound          = "not_found"
	linearDetailMaxDescription = 8000
	linearDetailMaxLabels      = 20
)

var (
	linearDetailIdentifierPattern = regexp.MustCompile(`^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8}$`)
	linearIssueMissingPattern     = regexp.MustCompile(`(?i)^(?:error:\s*)?(?:` +
		`(?:issue|entity)(?:\s+(?:with identifier\s+)?["']?[a-z][a-z0-9]*-[0-9]+["']?)?\s+` +
		`(?:(?:was |is )?not found|does not exist|is not visible)|` +
		`no (?:issue|entity) found|could not find (?:the )?(?:referenced )?(?:issue|entity))\b`)
)

type linearIssueDetail struct {
	Identifier  string   `json:"identifier"`
	Title       string   `json:"title"`
	URL         *string  `json:"url"`
	Status      *string  `json:"status"`
	StatusType  *string  `json:"status_type"`
	Priority    *int     `json:"priority"`
	Project     *string  `json:"project"`
	TeamKey     *string  `json:"team_key"`
	DueDate     *string  `json:"due_date"`
	UpdatedAt   *string  `json:"updated_at"`
	Assignee    *string  `json:"assignee"`
	Labels      []string `json:"labels"`
	Description *string  `json:"description"`
}

type linearIssuePayload struct {
	Source *string            `json:"source"`
	Issue  *linearIssueDetail `json:"issue"`
	Error  *string            `json:"error"`
}

// Holding the credential lock through the fetch keeps the read on the
// resolved generation, just as for issues. Detail has no disk cache.
func linearReadIssue(ctx context.Context, identifier string) linearIssuePayload {
	unlock, err := linearCredentialLock(ctx)
	if err != nil {
		return linearIssuePayload{Error: strPtr(linearErrBusy)}
	}
	defer unlock()
	cred, code := linearResolve(ctx, time.Now())
	out := linearIssuePayload{Source: linearOptional(cred.Source)}
	if code != "" {
		out.Error = strPtr(code)
		return out
	}
	var issue linearIssueDetail
	if cred.Source == linearSourceAPIKey {
		issue, err = linearGraphQLIssue(ctx, cred.Secret, identifier)
	} else {
		issue, err = linearMCPIssue(ctx, cred, identifier)
	}
	if err != nil {
		out.Error = strPtr(linearCode(err))
		return out
	}
	if issue.Identifier != identifier || issue.Title == "" || issue.containsSecret(cred.Secret) {
		out.Error = strPtr(linearErrBadResponse)
		return out
	}
	if issue.DueDate != nil && !linearDatePattern.MatchString(*issue.DueDate) {
		issue.DueDate = nil
	}
	if issue.Labels == nil {
		issue.Labels = []string{}
	}
	if len(issue.Labels) > linearDetailMaxLabels {
		issue.Labels = issue.Labels[:linearDetailMaxLabels]
	}
	if issue.Description != nil {
		issue.Description = strPtr(linearCapDescription(*issue.Description))
	}
	out.Issue = &issue
	return out
}

func linearCapDescription(s string) string {
	runes := 0
	for offset := range s {
		if runes == linearDetailMaxDescription {
			return s[:offset] + "…"
		}
		runes++
	}
	return s
}

// Only fixed errors leave the helper if a provider echoes the credential,
// including when it appears in a successful response.
func (issue linearIssueDetail) containsSecret(secret string) bool {
	if secret == "" {
		return false
	}
	for _, s := range []*string{&issue.Identifier, &issue.Title, issue.URL, issue.Status, issue.StatusType,
		issue.Project, issue.TeamKey, issue.DueDate, issue.UpdatedAt, issue.Assignee, issue.Description} {
		if s != nil && strings.Contains(*s, secret) {
			return true
		}
	}
	for _, label := range issue.Labels {
		if strings.Contains(label, secret) {
			return true
		}
	}
	return false
}

func linearDetailPriority(value *float64) *int {
	if value == nil {
		return nil
	}
	rounded := math.Round(*value)
	priority := 0
	if rounded >= 1 && rounded <= 4 {
		priority = int(rounded)
	}
	return &priority
}

// Linear uses these phrases in provider errors. Match only for issue detail,
// preserving the public error behavior of the other Linear commands.
func linearIssueMissing(message string) bool {
	return linearIssueMissingPattern.MatchString(strings.TrimSpace(message))
}
