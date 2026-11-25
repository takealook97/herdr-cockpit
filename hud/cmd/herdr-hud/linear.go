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
	// linearCleanupTimeout bounds post-commit steps; they never reuse the
	// possibly canceled command context.
	linearCleanupTimeout = 5 * time.Second
	linearUsage          = "usage: herdr-hud linear status|issues [--max-age 60s] [--refresh]|issue IDENTIFIER|complete IDENTIFIER|restore IDENTIFIER TOKEN|connect --key KEY|disconnect"
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
	case "issue":
		if len(args) != 2 || !linearDetailIdentifierPattern.MatchString(args[1]) {
			out, code = linearIssuePayload{Error: strPtr(linearErrBadRequest)}, 2
			break
		}
		out = linearReadIssue(ctx, args[1])
	case "complete", "restore":
		var token *string
		if args[0] == "restore" && len(args) == 3 && linearValidStateToken(args[2]) {
			token = &args[2]
		}
		if len(args) < 2 || !linearDetailIdentifierPattern.MatchString(args[1]) ||
			(args[0] == "complete" && len(args) != 2) || (args[0] == "restore" && token == nil) {
			out, code = linearStatePayload{Error: strPtr(linearErrBadRequest)}, 2
			break
		}
		out, code = linearSetState(ctx, args[1], token)
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

// linearBusyStatus is reported when the credential lock is unavailable; no
// credential was read and no meta was written.
func linearBusyStatus() linearStatusPayload {
	return linearStatusPayload{Error: strPtr(linearErrBusy)}
}

func linearBusyIssues() linearIssuesPayload {
	return linearIssuesPayload{Issues: []linearIssue{}, Error: strPtr(linearErrBusy)}
}

// linearStatusSnapshot is the part of status that reads the credential store
// and meta. The caller holds the credential lock.
type linearStatusSnapshot struct {
	cred linearCred
	code string
	id   linearIdentity
}

func linearTakeStatusSnapshot(ctx context.Context) linearStatusSnapshot {
	cred, code := linearResolve(ctx, time.Now())
	snap := linearStatusSnapshot{cred: cred, code: code}
	if code == "" && cred.Source == linearSourceAPIKey {
		// Meta written for another generation describes another key; show nothing.
		if meta, ok := linearMetaLoad(); ok && meta.Generation == cred.Generation {
			snap.id = linearIdentity{UserName: meta.UserName, OrgName: meta.OrgName, OrgURL: meta.OrgURL}
		}
	}
	return snap
}

func linearStatus(ctx context.Context) linearStatusPayload {
	wait, cancel := context.WithTimeout(ctx, linearStatusLockWait)
	unlock, err := linearCredentialLock(wait)
	cancel()
	if err != nil {
		return linearBusyStatus()
	}
	snap := linearTakeStatusSnapshot(ctx)
	unlock()
	return linearStatusFromSnapshot(ctx, snap)
}

// linearStatusFromSnapshot builds the payload outside the lock; only the MCP
// whoami call touches the network.
func linearStatusFromSnapshot(ctx context.Context, snap linearStatusSnapshot) linearStatusPayload {
	cred := snap.cred
	out := linearStatusPayload{}
	if cred.Source != "" {
		out.Source = strPtr(cred.Source)
	}
	if !cred.ExpiresAt.IsZero() {
		out.ExpiresAt = strPtr(cred.ExpiresAt.UTC().Format(time.RFC3339))
	}
	if snap.code != "" {
		out.Error = strPtr(snap.code)
		return out
	}
	out.Connected = true
	id := snap.id
	if cred.Source != linearSourceAPIKey {
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
	item := linearStoredKey{V: linearStoreVersion, APIKey: key, Generation: linearNewGeneration()}
	unlock, err := linearCredentialLock(ctx)
	if err != nil {
		return linearErrorPayload{linearErrStoreFailed}, 1
	}
	defer unlock()
	// The single store write is the commit point. On failure nothing changed.
	if err := linearStoreWrite(ctx, item); err != nil {
		return linearErrorPayload{linearErrStoreFailed}, 1
	}
	// Best effort: the old cache and meta carry another generation, so even if
	// these steps fail they are never served or shown for this key.
	_ = linearRemoveIfPresent(linearCachePath())
	_ = linearMetaSave(linearMeta{Generation: item.Generation, UserName: id.UserName, OrgName: id.OrgName, OrgURL: id.OrgURL})
	snap := linearStatusSnapshot{
		cred: linearCred{Source: linearSourceAPIKey, Secret: item.APIKey, Generation: item.Generation},
		id:   id,
	}
	return linearStatusFromSnapshot(ctx, snap), 0
}

func linearDisconnect(ctx context.Context) (any, int) {
	unlock, err := linearCredentialLock(ctx)
	if err != nil {
		return linearErrorPayload{linearErrStoreFailed}, 1
	}
	if err := linearStoreDelete(ctx); err != nil {
		unlock()
		return linearErrorPayload{linearErrStoreFailed}, 1
	}
	_ = linearRemoveIfPresent(linearCachePath())
	_ = linearRemoveIfPresent(linearMetaFilePath())
	// Snapshot under the same lock hold with a fresh context, so neither a
	// concurrent poll nor a canceled command context distorts the result.
	cleanup, cancel := context.WithTimeout(context.Background(), linearCleanupTimeout)
	snap := linearTakeStatusSnapshot(cleanup)
	cancel()
	unlock()
	return linearStatusFromSnapshot(ctx, snap), 0
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

// linearIssues holds the credential lock from resolution through the cache
// write, so a concurrent connect cannot pair this key with a new generation.
// The same lock coalesces concurrent fetches. Without the lock it reports busy:
// the store may hold a key whose replacement has not committed.
func linearIssues(ctx context.Context, maxAge time.Duration, refresh bool, now time.Time) linearIssuesPayload {
	unlock, err := linearCredentialLock(ctx)
	if err != nil {
		return linearBusyIssues()
	}
	defer unlock()
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
