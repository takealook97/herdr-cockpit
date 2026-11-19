package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	linearOverallTimeout = 20 * time.Second
	linearWhoamiTimeout  = 5 * time.Second
	linearDefaultMaxAge  = 60 * time.Second
	linearMaxKeyLength   = 200
	linearUsage          = "usage: herdr-hud linear status|issues [--max-age 60s] [--refresh]|connect --key KEY|disconnect"
)

var (
	linearIdentifierPattern = regexp.MustCompile(`^[A-Z][A-Z0-9]*-[0-9]+$`)
	linearURLKeyPattern     = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	linearDatePattern       = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)
	linearStatusTypes       = map[string]bool{"triage": true, "backlog": true, "unstarted": true, "started": true}
)

type linearUser struct {
	Name string `json:"name"`
}

type linearOrg struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

type linearStatusPayload struct {
	Connected bool        `json:"connected"`
	Source    *string     `json:"source"`
	User      *linearUser `json:"user"`
	Org       *linearOrg  `json:"org"`
	ExpiresAt *string     `json:"expires_at"`
	Error     *string     `json:"error"`
}

type linearIssue struct {
	Identifier string  `json:"identifier"`
	Title      string  `json:"title"`
	URL        string  `json:"url"`
	Status     string  `json:"status"`
	StatusType string  `json:"status_type"`
	Priority   int     `json:"priority"`
	Project    *string `json:"project"`
	TeamKey    *string `json:"team_key"`
	DueDate    *string `json:"due_date"`
	UpdatedAt  string  `json:"updated_at"`
}

type linearIssuesPayload struct {
	Source    *string       `json:"source"`
	OrgURL    *string       `json:"org_url"`
	FetchedAt *string       `json:"fetched_at"`
	Stale     bool          `json:"stale"`
	Issues    []linearIssue `json:"issues"`
	Error     *string       `json:"error"`
}

type linearErrorPayload struct {
	Error string `json:"error"`
}

// linearRawIssue is the route-independent shape normalized into linearIssue.
type linearRawIssue struct {
	Identifier, Title, URL, Status, StatusType, UpdatedAt string
	Priority                                              float64
	Project, DueDate                                      *string
}

func strPtr(s string) *string { return &s }

func linearOptional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func linearOrgURLFromKey(key string) string {
	if !linearURLKeyPattern.MatchString(key) {
		return ""
	}
	return "https://linear.app/" + key
}

func linearOrgURLFromURL(raw string) string {
	return linearOrgURLFromKey(strings.TrimSuffix(strings.TrimPrefix(raw, "https://linear.app/"), "/"))
}

// linearNormalize drops rows without a valid identifier, Linear URL or an open
// status type, and clamps priority to 0..4.
func linearNormalize(raw linearRawIssue) (linearIssue, bool) {
	statusType := strings.ToLower(raw.StatusType)
	if !linearIdentifierPattern.MatchString(raw.Identifier) || !strings.HasPrefix(raw.URL, "https://linear.app/") || !linearStatusTypes[statusType] {
		return linearIssue{}, false
	}
	priority := int(math.Round(raw.Priority))
	if math.IsNaN(raw.Priority) || priority < 0 || priority > 4 {
		priority = 0
	}
	var due *string
	if raw.DueDate != nil && linearDatePattern.MatchString(*raw.DueDate) {
		due = strPtr(*raw.DueDate)
	}
	var project *string
	if raw.Project != nil {
		project = linearOptional(*raw.Project)
	}
	team := raw.Identifier[:strings.Index(raw.Identifier, "-")]
	return linearIssue{
		Identifier: raw.Identifier, Title: raw.Title, URL: raw.URL, Status: raw.Status, StatusType: statusType,
		Priority: priority, Project: project, TeamKey: &team, DueDate: due, UpdatedAt: raw.UpdatedAt,
	}, true
}

func cmdLinear(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	usage := func() int {
		fmt.Fprintln(stderr, linearUsage)
		return 2
	}
	if len(args) == 0 {
		return usage()
	}
	ctx, cancel := context.WithTimeout(ctx, linearOverallTimeout)
	defer cancel()
	var out any
	code := 0
	switch args[0] {
	case "status":
		if len(args) != 1 {
			return usage()
		}
		out = linearStatus(ctx)
	case "issues":
		fs := flag.NewFlagSet("herdr-hud linear issues", flag.ContinueOnError)
		fs.SetOutput(io.Discard)
		age := fs.Duration("max-age", linearDefaultMaxAge, "cache freshness")
		refresh := fs.Bool("refresh", false, "fetch even when the cache is fresh")
		if fs.Parse(args[1:]) != nil || fs.NArg() != 0 || *age < 0 {
			return usage()
		}
		out = linearIssues(ctx, *age, *refresh, time.Now())
	case "connect":
		fs := flag.NewFlagSet("herdr-hud linear connect", flag.ContinueOnError)
		// Never echo flag errors: the offending argument may be the key.
		fs.SetOutput(io.Discard)
		key := fs.String("key", "", "Linear personal API key")
		if fs.Parse(args[1:]) != nil || fs.NArg() != 0 {
			return usage()
		}
		out, code = linearConnect(ctx, *key)
	case "disconnect":
		if len(args) != 1 {
			return usage()
		}
		out, code = linearDisconnect(ctx)
	default:
		return usage()
	}
	if err := json.NewEncoder(stdout).Encode(out); err != nil {
		fmt.Fprintln(stderr, "herdr-hud linear: write failed")
		return 1
	}
	return code
}

func linearStatus(ctx context.Context) linearStatusPayload {
	cred, code := linearResolve(ctx, time.Now())
	out := linearStatusPayload{}
	if cred.Source != "" {
		out.Source = strPtr(cred.Source)
	}
	if !cred.ExpiresAt.IsZero() {
		out.ExpiresAt = strPtr(cred.ExpiresAt.UTC().Format(time.RFC3339))
	}
	if code != "" {
		out.Error = strPtr(code)
		return out
	}
	out.Connected = true
	var id linearIdentity
	if cred.Source == linearSourceAPIKey {
		meta, _ := linearMetaLoad()
		id = linearIdentity{UserName: meta.UserName, OrgName: meta.OrgName, OrgURL: meta.OrgURL}
	} else {
		child, cancel := context.WithTimeout(ctx, linearWhoamiTimeout)
		id, _ = linearMCPWhoami(child, cred)
		cancel()
	}
	if id.UserName != "" {
		out.User = &linearUser{Name: id.UserName}
	}
	if id.OrgName != "" || id.OrgURL != "" {
		out.Org = &linearOrg{Name: id.OrgName, URL: id.OrgURL}
	}
	return out
}

func linearValidKey(key string) bool {
	if key == "" || len(key) > linearMaxKeyLength {
		return false
	}
	for _, r := range key {
		if r < 0x21 || r > 0x7e {
			return false
		}
	}
	return true
}

func linearConnect(ctx context.Context, key string) (any, int) {
	key = strings.TrimSpace(key)
	if !linearValidKey(key) {
		return linearErrorPayload{linearErrInvalidKey}, 1
	}
	id, err := linearGraphQLViewer(ctx, key)
	if err != nil {
		return linearErrorPayload{linearCode(err)}, 1
	}
	if linearAPIKeyStore(ctx, key) != nil {
		return linearErrorPayload{linearErrStoreFailed}, 1
	}
	meta := linearMeta{Generation: linearNewGeneration(), UserName: id.UserName, OrgName: id.OrgName, OrgURL: id.OrgURL}
	if linearMetaSave(meta) != nil {
		_ = linearAPIKeyDelete(ctx)
		return linearErrorPayload{linearErrStoreFailed}, 1
	}
	_ = linearRemoveIfPresent(linearCachePath())
	return linearStatus(ctx), 0
}

func linearDisconnect(ctx context.Context) (any, int) {
	if linearAPIKeyDelete(ctx) != nil || linearRemoveIfPresent(linearMetaFilePath()) != nil {
		return linearErrorPayload{linearErrStoreFailed}, 1
	}
	_ = linearRemoveIfPresent(linearCachePath())
	return linearStatus(ctx), 0
}

// Cache: only the issues payload and the nonsecret credential generation.

type linearCacheEntry struct {
	Generation string              `json:"generation"`
	FetchedAt  time.Time           `json:"fetched_at"`
	Payload    linearIssuesPayload `json:"payload"`
}

func linearCachePath() string { return filepath.Join(hudCacheDir(), "linear-issues.json") }

func linearReadCache(generation string) (linearCacheEntry, bool) {
	raw, err := os.ReadFile(linearCachePath())
	if err != nil {
		return linearCacheEntry{}, false
	}
	var entry linearCacheEntry
	if json.Unmarshal(raw, &entry) != nil || entry.Generation != generation || entry.FetchedAt.IsZero() {
		return linearCacheEntry{}, false
	}
	if entry.Payload.Issues == nil {
		entry.Payload.Issues = []linearIssue{}
	}
	return entry, true
}

func linearWriteCache(entry linearCacheEntry) error {
	raw, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	return hudWritePrivateFile(linearCachePath(), raw)
}

var linearFetchIssues = func(ctx context.Context, cred linearCred) (linearIssuesPayload, error) {
	if cred.Source == linearSourceAPIKey {
		return linearGraphQLIssues(ctx, cred.Secret)
	}
	return linearMCPIssues(ctx, cred)
}

func linearIssues(ctx context.Context, maxAge time.Duration, refresh bool, now time.Time) linearIssuesPayload {
	cred, code := linearResolve(ctx, now)
	if code != "" {
		out := linearIssuesPayload{Issues: []linearIssue{}, Error: strPtr(code)}
		if cred.Source != "" {
			out.Source = strPtr(cred.Source)
		}
		return out
	}
	fresh := func(entry linearCacheEntry) bool {
		if refresh {
			// A fetch that finished after this command started satisfies the refresh.
			return !entry.FetchedAt.Before(now)
		}
		return now.Sub(entry.FetchedAt) <= maxAge
	}
	if entry, ok := linearReadCache(cred.Generation); ok && fresh(entry) {
		return entry.Payload
	}
	unlock, lockErr := hudLockFile(ctx, linearCachePath())
	if lockErr == nil {
		defer unlock()
		if entry, ok := linearReadCache(cred.Generation); ok && fresh(entry) {
			return entry.Payload
		}
	}
	payload, err := linearFetchIssues(ctx, cred)
	if err != nil {
		code := linearCode(err)
		if entry, ok := linearReadCache(cred.Generation); ok {
			entry.Payload.Stale = true
			entry.Payload.Error = strPtr(code)
			return entry.Payload
		}
		payload.Stale = len(payload.Issues) > 0
		payload.Error = strPtr(code)
		return payload
	}
	fetched := time.Now()
	payload.FetchedAt = strPtr(fetched.UTC().Format(time.RFC3339))
	payload.Stale = false
	payload.Error = nil
	_ = linearWriteCache(linearCacheEntry{Generation: cred.Generation, FetchedAt: fetched, Payload: payload})
	return payload
}
