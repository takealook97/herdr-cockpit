package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	linearTestAPIKey   = "lin_api_FAKESECRETkey0123456789"
	linearTestMCPToken = "mcp-FAKE-TOKEN-secret-xyz"
)

func linearFixture(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "linear", name))
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(raw))
}

// fakeKeychain stands in for the macOS security command.
type fakeKeychain struct {
	mu        sync.Mutex
	key       string
	failStore bool
	failAll   bool // every command fails with a non-44 status (locked keychain)
	calls     [][]string
}

// fakeExitError mimics *exec.ExitError's ExitCode for security(1) failures.
type fakeExitError int

func (e fakeExitError) Error() string { return fmt.Sprintf("exit status %d", int(e)) }
func (e fakeExitError) ExitCode() int { return int(e) }

const errKeychainMissing = fakeExitError(linearKeychainNotFound)

func (k *fakeKeychain) run(_ context.Context, args ...string) ([]byte, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.calls = append(k.calls, append([]string(nil), args...))
	if len(args) < 5 || args[1] != "-s" || args[2] != linearKeychainService || args[3] != "-a" || args[4] != linearKeychainAccount {
		return nil, errors.New("unexpected keychain target")
	}
	if k.failAll {
		return nil, fakeExitError(36)
	}
	switch args[0] {
	case "find-generic-password":
		if k.key == "" {
			return nil, errKeychainMissing
		}
		return []byte(k.key + "\n"), nil
	case "add-generic-password":
		if k.failStore {
			return nil, errors.New("denied")
		}
		k.key = args[len(args)-1]
		return nil, nil
	case "delete-generic-password":
		if k.key == "" {
			return nil, errKeychainMissing
		}
		k.key = ""
		return nil, nil
	}
	return nil, errors.New("unknown verb")
}

// linearStoredJSON is the store item a connect of key under gen would write.
func linearStoredJSON(key, gen string) string {
	raw, _ := json.Marshal(linearStoredKey{V: linearStoreVersion, APIKey: key, Generation: gen})
	return string(raw)
}

// apiKey returns the key held by the fake keychain item, "" when absent or malformed.
func (k *fakeKeychain) apiKey() string {
	k.mu.Lock()
	defer k.mu.Unlock()
	item, err := linearParseStoredKey([]byte(k.key))
	if err != nil {
		return ""
	}
	return item.APIKey
}

type linearEnv struct {
	keychain *fakeKeychain
	claude   []byte
	config   string
	cache    string
}

// setupLinear isolates every credential, cache and network seam for one test.
func setupLinear(t *testing.T) *linearEnv {
	t.Helper()
	env := &linearEnv{keychain: &fakeKeychain{}, config: t.TempDir(), cache: t.TempDir()}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PATH", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", env.config)
	t.Setenv("XDG_CACHE_HOME", env.cache)
	goos, run, raw, claudeKC := linearGOOS, linearSecurityRun, linearClaudeRaw, hudClaudeKeychainRead
	transport, gql, mcp, fetch := linearHTTPTransport, linearGraphQLEndpoint, linearMCPEndpointOverride, linearFetchIssues
	t.Cleanup(func() {
		linearGOOS, linearSecurityRun, linearClaudeRaw, hudClaudeKeychainRead = goos, run, raw, claudeKC
		linearHTTPTransport, linearGraphQLEndpoint, linearMCPEndpointOverride, linearFetchIssues = transport, gql, mcp, fetch
	})
	linearGOOS = "darwin"
	linearSecurityRun = env.keychain.run
	linearClaudeRaw = func(context.Context) ([]byte, error) { return env.claude, nil }
	hudClaudeKeychainRead = func(context.Context, string) ([]byte, error) { return nil, errKeychainMissing }
	linearGraphQLEndpoint = "https://graphql.invalid/unset"
	linearHTTPTransport = hudTestTransport(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("unexpected network call")
	})
	return env
}

func linearClaudeCreds(entries map[string]map[string]any) []byte {
	raw, _ := json.Marshal(map[string]any{"claudeAiOauth": map[string]any{"accessToken": "unrelated"}, "mcpOAuth": entries})
	return raw
}

func linearMCPCred(expiresAt int64) map[string]any {
	return map[string]any{"serverName": "linear", "serverUrl": linearMCPPreferredURL, "accessToken": linearTestMCPToken, "expiresAt": expiresAt, "clientId": "client-1"}
}

// fakeMCP serves the Linear MCP fixtures over TLS.
type fakeMCP struct {
	t                *testing.T
	srv              *httptest.Server
	mu               sync.Mutex
	sse              bool
	status           int
	failPage         int
	whoami           string // "" serves the fixture; "rpc" a JSON-RPC error; "tool" an isError result
	noIssueTool      bool
	issueResult      string
	stateTools       string
	saveResult       string
	savedIssueResult string
	saved            bool
	requests         []fakeMCPRequest
}

type fakeMCPRequest struct {
	Method  string
	Header  http.Header
	Params  json.RawMessage
	IsNotif bool
}

func newFakeMCP(t *testing.T) *fakeMCP {
	f := &fakeMCP{t: t}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	linearHTTPTransport = f.srv.Client().Transport
	linearMCPEndpointOverride = f.srv.URL + "/mcp"
	return f
}

func (f *fakeMCP) serve(w http.ResponseWriter, r *http.Request) {
	var msg struct {
		ID     *int            `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	raw, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(raw, &msg)
	f.mu.Lock()
	f.requests = append(f.requests, fakeMCPRequest{msg.Method, r.Header.Clone(), msg.Params, msg.ID == nil})
	status, sse, failPage, whoami := f.status, f.sse, f.failPage, f.whoami
	saved := f.saved
	f.mu.Unlock()
	if status != 0 {
		w.WriteHeader(status)
		fmt.Fprint(w, `{"error":"echo `+r.Header.Get("Authorization")+`"}`)
		return
	}
	if msg.ID == nil {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	var result string
	switch msg.Method {
	case "initialize":
		w.Header().Set("Mcp-Session-Id", "session-fixture")
		result = `{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fixture"}}`
	case "tools/list":
		result = linearFixture(f.t, "mcp_tools_list.json")
		if f.stateTools != "" {
			result = f.stateTools
		}
		if f.noIssueTool {
			result = `{"tools":[]}`
		}
	case "tools/call":
		var call struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		_ = json.Unmarshal(msg.Params, &call)
		text := ""
		switch {
		case call.Name == "get_issue":
			result = f.issueResult
			if saved {
				result = f.savedIssueResult
			}
		case call.Name == "save_issue":
			result = f.saveResult
			f.mu.Lock()
			f.saved = true
			f.mu.Unlock()
		case call.Name == "whoami" && whoami == "rpc":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%d,"error":{"code":-32603,"message":"internal"}}`, *msg.ID)
			return
		case call.Name == "whoami" && whoami == "tool":
			result = `{"isError":true,"content":[{"type":"text","text":"whoami failed"}]}`
		case call.Name == "whoami":
			text = linearFixture(f.t, "mcp_whoami.json")
		case call.Name == "list_issues" && call.Arguments["cursor"] == nil:
			text = linearFixture(f.t, "mcp_issues_page1.json")
		case call.Name == "list_issues" && failPage == 2:
			result = `{"isError":true,"content":[{"type":"text","text":"boom"}]}`
		case call.Name == "list_issues":
			text = linearFixture(f.t, "mcp_issues_page2.json")
		}
		if result == "" {
			quoted, _ := json.Marshal(text)
			result = `{"content":[{"type":"text","text":` + string(quoted) + `}]}`
		}
	}
	body := fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"result":%s}`, *msg.ID, result)
	if sse {
		w.Header().Set("Content-Type", "text/event-stream")
		// A notification and an unrelated id precede the answer; the stream then
		// stays open, so the reader must stop at the matching event.
		fmt.Fprintf(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n")
		fmt.Fprintf(w, "data: {\"jsonrpc\":\"2.0\",\"id\":999,\"result\":{}}\n\n")
		fmt.Fprintf(w, "event: message\ndata: %s\n\n", body)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		return
	}
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, body)
}

func (f *fakeMCP) calls() []fakeMCPRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeMCPRequest(nil), f.requests...)
}

func linearRun(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := cmdLinear(context.Background(), args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func linearIdentifiers(issues []linearIssue) []string {
	ids := []string{}
	for _, issue := range issues {
		ids = append(ids, issue.Identifier)
	}
	return ids
}

func TestLinearMCPIssuesJSONAndSSE(t *testing.T) {
	for _, sse := range []bool{false, true} {
		t.Run(fmt.Sprintf("sse=%v", sse), func(t *testing.T) {
			env := setupLinear(t)
			env.claude = linearClaudeCreds(map[string]map[string]any{"linear|a": linearMCPCred(time.Now().Add(time.Hour).UnixMilli())})
			mcp := newFakeMCP(t)
			mcp.sse = sse
			code, stdout, stderr := linearRun(t, "issues")
			if code != 0 || stderr != "" {
				t.Fatalf("exit %d stderr %q", code, stderr)
			}
			var out linearIssuesPayload
			if err := json.Unmarshal([]byte(stdout), &out); err != nil {
				t.Fatal(err)
			}
			if out.Error != nil || out.Stale || out.Source == nil || *out.Source != linearSourceClaudeMCP || out.OrgURL == nil || *out.OrgURL != "https://linear.app/fixture" || out.FetchedAt == nil {
				t.Fatalf("payload %s", stdout)
			}
			if got := linearIdentifiers(out.Issues); !reflect.DeepEqual(got, []string{"FIX-12", "OPS2-7"}) {
				t.Fatalf("issues %v", got)
			}
			first, second := out.Issues[0], out.Issues[1]
			if first.Priority != 3 || *first.TeamKey != "FIX" || *first.Project != "Cockpit / HUD" || *first.DueDate != "2026-11-24" || first.StatusType != "started" {
				t.Fatalf("first %+v", first)
			}
			if second.Priority != 0 || *second.TeamKey != "OPS2" || second.DueDate != nil || second.Project != nil || second.StatusType != "triage" {
				t.Fatalf("second %+v", second)
			}
			calls := mcp.calls()
			methods := []string{}
			for _, c := range calls {
				methods = append(methods, c.Method)
				if c.Header.Get("Authorization") != "Bearer "+linearTestMCPToken || c.Header.Get("Accept") != "application/json, text/event-stream" || c.Header.Get("Content-Type") != "application/json" {
					t.Fatalf("headers %v", c.Header)
				}
				if c.Method != "initialize" && (c.Header.Get("Mcp-Session-Id") != "session-fixture" || c.Header.Get("MCP-Protocol-Version") != linearMCPProtocol) {
					t.Fatalf("session headers missing on %s", c.Method)
				}
			}
			want := []string{"initialize", "notifications/initialized", "tools/list", "tools/call", "tools/call", "tools/call"}
			if !reflect.DeepEqual(methods, want) {
				t.Fatalf("methods %v", methods)
			}
			var page2 struct {
				Arguments map[string]any `json:"arguments"`
			}
			_ = json.Unmarshal(calls[5].Params, &page2)
			if page2.Arguments["cursor"] != "cursor-page-2" || page2.Arguments["assignee"] != "me" || page2.Arguments["orderBy"] != "updatedAt" {
				t.Fatalf("page 2 args %v", page2.Arguments)
			}
		})
	}
}

func TestLinearMCPListArgsFollowSchema(t *testing.T) {
	var tool mcpTool
	tool.InputSchema.Properties = map[string]json.RawMessage{"assignee": json.RawMessage(`{}`), "limit": json.RawMessage(`{}`)}
	got := linearMCPListArgs(tool, "c1")
	if !reflect.DeepEqual(got, map[string]any{"assignee": "me", "limit": 100}) {
		t.Fatalf("args %v", got)
	}
}

func TestLinearMCPErrorMapping(t *testing.T) {
	for _, tc := range []struct {
		status int
		want   string
	}{{401, linearErrExpired}, {403, linearErrForbidden}, {500, linearErrNetwork}, {404, linearErrBadResponse}} {
		env := setupLinear(t)
		env.claude = linearClaudeCreds(map[string]map[string]any{"linear|a": linearMCPCred(0)})
		mcp := newFakeMCP(t)
		mcp.status = tc.status
		_, stdout, stderr := linearRun(t, "issues")
		if !strings.Contains(stdout, `"error":"`+tc.want+`"`) || strings.Contains(stdout, "echo") || stderr != "" {
			t.Fatalf("status %d: %s", tc.status, stdout)
		}
	}
}

func TestLinearMCPPartialPageServesCompletePagesStale(t *testing.T) {
	env := setupLinear(t)
	env.claude = linearClaudeCreds(map[string]map[string]any{"linear|a": linearMCPCred(0)})
	mcp := newFakeMCP(t)
	mcp.failPage = 2
	out := linearIssues(context.Background(), time.Minute, false, time.Now())
	if out.Error == nil || *out.Error != linearErrBadResponse || !out.Stale || !reflect.DeepEqual(linearIdentifiers(out.Issues), []string{"FIX-12"}) {
		t.Fatalf("partial %+v", out)
	}
	if _, err := os.Stat(linearCachePath()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a partial result must not be cached")
	}
}

func TestLinearMCPRedirectRefused(t *testing.T) {
	setupLinear(t)
	var leaked bool
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leaked = leaked || r.Header.Get("Authorization") != ""
	}))
	defer target.Close()
	origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer origin.Close()
	linearHTTPTransport = origin.Client().Transport
	linearMCPEndpointOverride = origin.URL
	_, err := linearMCPWhoami(context.Background(), linearCred{Source: linearSourceClaudeMCP, Secret: linearTestMCPToken, ServerURL: linearMCPPreferredURL})
	if linearCode(err) != linearErrBadResponse || leaked {
		t.Fatalf("redirect err %v leaked %v", err, leaked)
	}
}

func TestLinearSSEStopsAtMatchingEventAndCapsBody(t *testing.T) {
	stream := "data: {\"jsonrpc\":\"2.0\",\"id\":1,\n" + "data: \"result\":{\"ok\":true}}\n\n"
	msg, err := linearSSEFind(io.MultiReader(strings.NewReader(stream), blockingReader{}), 1)
	if err != nil || string(msg.Result) != `{"ok":true}` {
		t.Fatalf("multi-line data %s %v", msg.Result, err)
	}
	huge := "data: " + strings.Repeat("x", linearMaxBody+10) + "\n\n"
	if _, err := linearSSEFind(strings.NewReader(huge), 1); linearCode(err) != linearErrBadResponse {
		t.Fatalf("cap %v", err)
	}
	if _, err := linearSSEFind(strings.NewReader("data: {\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{}}\n\n"), 2); linearCode(err) != linearErrBadResponse {
		t.Fatalf("missing id %v", err)
	}
}

type blockingReader struct{}

func (blockingReader) Read([]byte) (int, error) { select {} }

func TestLinearJSONRPCErrorIsBadResponse(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"nope"}}`)
	}))
	defer srv.Close()
	s := &mcpSession{client: &http.Client{Transport: srv.Client().Transport}, url: srv.URL, token: "x"}
	if _, err := s.call(context.Background(), "initialize", nil); linearCode(err) != linearErrBadResponse {
		t.Fatalf("rpc error %v", err)
	}
}

func TestLinearMCPEntrySelection(t *testing.T) {
	now := time.UnixMilli(1_800_000_000_000)
	entry := func(url string, exp int64, token string) map[string]any {
		return map[string]any{"serverUrl": url, "accessToken": token, "expiresAt": exp, "clientId": "c"}
	}
	raw := linearClaudeCreds(map[string]map[string]any{
		"plain":   entry("http://mcp.linear.app/mcp", now.UnixMilli()+9e6, "bad1"),
		"port":    entry("https://mcp.linear.app:8443/mcp", now.UnixMilli()+9e6, "bad2"),
		"other":   entry("https://mcp.linear.app.evil.example/mcp", now.UnixMilli()+9e6, "bad3"),
		"user":    entry("https://x@mcp.linear.app/mcp", now.UnixMilli()+9e6, "bad4"),
		"sse":     entry("https://mcp.linear.app/sse", now.UnixMilli()+9e6, "later"),
		"exact":   entry(linearMCPPreferredURL, now.UnixMilli()+1000, "exact"),
		"notoken": entry(linearMCPPreferredURL, now.UnixMilli()+9e7, ""),
	})
	cred, found, expired := linearMCPEntry(raw, now)
	if !found || expired || cred.Secret != "exact" || cred.Generation != fmt.Sprintf("claude_mcp:exact:c:%d", now.UnixMilli()+1000) {
		t.Fatalf("selection %v %v %v gen %s", cred.Secret == "exact", found, expired, cred.Generation)
	}
	raw = linearClaudeCreds(map[string]map[string]any{
		"a": entry("https://mcp.linear.app/sse", now.UnixMilli()+10, "older"),
		"b": entry("https://MCP.linear.app/v2", now.UnixMilli()+20, "newer"),
	})
	if cred, _, _ := linearMCPEntry(raw, now); cred.Secret != "newer" {
		t.Fatal("latest expiresAt should win without an exact URL")
	}
	raw = linearClaudeCreds(map[string]map[string]any{"a": entry(linearMCPPreferredURL, now.UnixMilli(), "t")})
	if _, found, expired := linearMCPEntry(raw, now); !found || !expired {
		t.Fatal("expiresAt == now is expired")
	}
	if _, found, _ := linearMCPEntry([]byte(`{"claudeAiOauth":{}}`), now); found {
		t.Fatal("no entries")
	}
	if s := fmt.Sprintf("%v %+v %#v", cred, cred, cred); strings.Contains(s, cred.Secret) {
		t.Fatal("cred formatting must redact the secret")
	}
}

func TestLinearResolveOrderAndExpiry(t *testing.T) {
	env := setupLinear(t)
	if _, code := linearResolve(context.Background(), time.Now()); code != linearErrNotConnected {
		t.Fatalf("empty %s", code)
	}
	env.claude = linearClaudeCreds(map[string]map[string]any{"linear|a": linearMCPCred(time.Now().Add(-time.Minute).UnixMilli())})
	code, stdout, _ := linearRun(t, "issues")
	if code != 0 || !strings.Contains(stdout, `"error":"expired"`) || !strings.Contains(stdout, `"source":"claude_mcp"`) {
		t.Fatalf("expired issues %s", stdout)
	}
	_, stdout, _ = linearRun(t, "status")
	var status linearStatusPayload
	_ = json.Unmarshal([]byte(stdout), &status)
	if status.Connected || status.ExpiresAt == nil || status.Error == nil || *status.Error != linearErrExpired {
		t.Fatalf("expired status %s", stdout)
	}
	env.keychain.key = linearStoredJSON(linearTestAPIKey, "api_key:fixture")
	cred, code2 := linearResolve(context.Background(), time.Now())
	if code2 != "" || cred.Source != linearSourceAPIKey || !strings.HasPrefix(cred.Generation, "api_key:") {
		t.Fatalf("api key first %s %s", cred, code2)
	}
	again, _ := linearResolve(context.Background(), time.Now())
	if again.Generation != cred.Generation {
		t.Fatal("generation must be stable once recorded")
	}
}

func TestLinearStatusMCPWhoami(t *testing.T) {
	env := setupLinear(t)
	env.claude = linearClaudeCreds(map[string]map[string]any{"linear|a": linearMCPCred(time.Now().Add(2 * time.Hour).UnixMilli())})
	newFakeMCP(t)
	_, stdout, _ := linearRun(t, "status")
	var out linearStatusPayload
	_ = json.Unmarshal([]byte(stdout), &out)
	if !out.Connected || out.User == nil || out.User.Name != "Fixture Person" || out.Org == nil || out.Org.URL != "https://linear.app/fixture" || out.ExpiresAt == nil || out.Error != nil {
		t.Fatalf("status %s", stdout)
	}
	linearHTTPTransport = hudTestTransport(func(*http.Request) (*http.Response, error) { return nil, errors.New("down") })
	_, stdout, _ = linearRun(t, "status")
	if !strings.Contains(stdout, `"connected":true`) || !strings.Contains(stdout, `"user":null`) {
		t.Fatalf("whoami failure keeps connected: %s", stdout)
	}
}

// graphQLServer answers viewer and paginated issue queries from fixtures.
func graphQLServer(t *testing.T, handler func(query string, vars map[string]any, w http.ResponseWriter)) *[]http.Header {
	headers := &[]http.Header{}
	var mu sync.Mutex
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		*headers = append(*headers, r.Header.Clone())
		mu.Unlock()
		handler(body.Query, body.Variables, w)
	}))
	t.Cleanup(srv.Close)
	linearHTTPTransport = srv.Client().Transport
	linearGraphQLEndpoint = srv.URL + "/graphql"
	return headers
}

func linearDefaultGraphQL(t *testing.T) func(string, map[string]any, http.ResponseWriter) {
	return func(query string, vars map[string]any, w http.ResponseWriter) {
		switch {
		case strings.Contains(query, "HerdrHudViewer"):
			fmt.Fprint(w, linearFixture(t, "graphql_viewer.json"))
		case vars["after"] == nil:
			fmt.Fprint(w, linearFixture(t, "graphql_issues_page1.json"))
		case vars["after"] == "gql-cursor-2":
			fmt.Fprint(w, linearFixture(t, "graphql_issues_page2.json"))
		default:
			t.Errorf("unexpected cursor %v", vars["after"])
		}
	}
}

func TestLinearConnectIssuesDisconnect(t *testing.T) {
	env := setupLinear(t)
	headers := graphQLServer(t, linearDefaultGraphQL(t))
	code, stdout, stderr := linearRun(t, "connect", "--key", "  "+linearTestAPIKey+"\n")
	if code != 0 || stderr != "" {
		t.Fatalf("connect %d %s %s", code, stdout, stderr)
	}
	var status linearStatusPayload
	_ = json.Unmarshal([]byte(stdout), &status)
	if !status.Connected || *status.Source != linearSourceAPIKey || status.User.Name != "Fixture Person" || status.Org.Name != "Fixture Org" || status.Org.URL != "https://linear.app/fixture" {
		t.Fatalf("status %s", stdout)
	}
	if env.keychain.apiKey() != linearTestAPIKey || (*headers)[0].Get("Authorization") != linearTestAPIKey {
		t.Fatal("key must be trimmed, validated raw (no Bearer) and stored")
	}
	_, stdout, _ = linearRun(t, "issues")
	var issues linearIssuesPayload
	_ = json.Unmarshal([]byte(stdout), &issues)
	if issues.Error != nil || *issues.OrgURL != "https://linear.app/fixture" || !reflect.DeepEqual(linearIdentifiers(issues.Issues), []string{"FIX-20", "FIX-21"}) {
		t.Fatalf("issues %s", stdout)
	}
	if issues.Issues[0].Priority != 4 || *issues.Issues[0].Project != "Cockpit" || *issues.Issues[1].DueDate != "2026-12-01" || issues.Issues[1].Priority != 1 {
		t.Fatalf("normalized %+v", issues.Issues)
	}
	if _, err := os.Stat(linearCachePath()); err != nil {
		t.Fatal("cache missing")
	}
	env.claude = linearClaudeCreds(map[string]map[string]any{"linear|a": linearMCPCred(0)})
	code, stdout, _ = linearRun(t, "disconnect")
	if code != 0 || env.keychain.key != "" || !strings.Contains(stdout, `"source":"claude_mcp"`) {
		t.Fatalf("disconnect %d %s", code, stdout)
	}
	for _, path := range []string{linearCachePath(), linearMetaFilePath()} {
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s should be removed", path)
		}
	}
	env.claude = nil
	code, stdout, _ = linearRun(t, "disconnect")
	if code != 0 || !strings.Contains(stdout, `"error":"not_connected"`) {
		t.Fatalf("disconnect must be idempotent: %d %s", code, stdout)
	}
}

func TestLinearConnectFailuresStoreNothing(t *testing.T) {
	cases := []struct {
		name   string
		key    string
		reply  func(w http.ResponseWriter)
		want   string
		failKC bool
	}{
		{"empty", "   ", nil, linearErrInvalidKey, false},
		{"too long", strings.Repeat("k", linearMaxKeyLength+1), nil, linearErrInvalidKey, false},
		{"control char", "lin\tkey", nil, linearErrInvalidKey, false},
		{"auth envelope", "lin_api_x", func(w http.ResponseWriter) {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, `{"errors":[{"message":"Authentication required","extensions":{"code":"AUTHENTICATION_ERROR","type":"authentication error"}}]}`)
		}, linearErrInvalidKey, false},
		{"401", "lin_api_x", func(w http.ResponseWriter) { w.WriteHeader(http.StatusUnauthorized) }, linearErrInvalidKey, false},
		{"other errors", "lin_api_x", func(w http.ResponseWriter) {
			fmt.Fprint(w, `{"data":{"viewer":{"id":"v"}},"errors":[{"message":"rate limited"}]}`)
		}, linearErrBadResponse, false},
		{"empty viewer", "lin_api_x", func(w http.ResponseWriter) { fmt.Fprint(w, `{"data":{"viewer":{"id":""}}}`) }, linearErrInvalidKey, false},
		{"store failure", "lin_api_x", func(w http.ResponseWriter) { fmt.Fprint(w, linearFixture(t, "graphql_viewer.json")) }, linearErrStoreFailed, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := setupLinear(t)
			env.keychain.failStore = tc.failKC
			if tc.reply != nil {
				reply := tc.reply
				graphQLServer(t, func(_ string, _ map[string]any, w http.ResponseWriter) { reply(w) })
			}
			code, stdout, stderr := linearRun(t, "connect", "--key", tc.key)
			if code != 1 || strings.TrimSpace(stdout) != `{"error":"`+tc.want+`"}` || stderr != "" {
				t.Fatalf("got %d %q %q", code, stdout, stderr)
			}
			if env.keychain.key != "" {
				t.Fatal("nothing may be stored on failure")
			}
			if _, err := os.Stat(linearMetaFilePath()); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("meta must not be written on failure")
			}
		})
	}
}

func TestLinearGraphQLIssuesErrorsEnvelope(t *testing.T) {
	env := setupLinear(t)
	env.keychain.key = linearStoredJSON(linearTestAPIKey, "api_key:fixture")
	graphQLServer(t, func(_ string, _ map[string]any, w http.ResponseWriter) {
		fmt.Fprint(w, `{"data":null,"errors":[{"message":"query too complex"}]}`)
	})
	out := linearIssues(context.Background(), time.Minute, false, time.Now())
	if out.Error == nil || *out.Error != linearErrBadResponse || len(out.Issues) != 0 || out.Stale {
		t.Fatalf("errors envelope %+v", out)
	}
}

func TestLinearCacheFreshnessGenerationAndStale(t *testing.T) {
	env := setupLinear(t)
	env.keychain.key = linearStoredJSON(linearTestAPIKey, "api_key:fixture")
	fetches := 0
	fail := false
	linearFetchIssues = func(_ context.Context, cred linearCred) (linearIssuesPayload, error) {
		fetches++
		if fail {
			return linearIssuesPayload{Source: strPtr(cred.Source), Issues: []linearIssue{}}, linearError(linearErrNetwork)
		}
		team := "FIX"
		return linearIssuesPayload{Source: strPtr(cred.Source), Issues: []linearIssue{{Identifier: fmt.Sprintf("FIX-%d", fetches), TeamKey: &team}}}, nil
	}
	now := time.Now()
	first := linearIssues(context.Background(), time.Minute, false, now)
	second := linearIssues(context.Background(), time.Minute, false, now.Add(30*time.Second))
	if fetches != 1 || second.Issues[0].Identifier != "FIX-1" || second.Stale {
		t.Fatalf("fresh cache not served: fetches %d %+v", fetches, second)
	}
	linearIssues(context.Background(), time.Minute, false, now.Add(2*time.Minute))
	if fetches != 2 {
		t.Fatal("expired cache must refetch")
	}
	linearIssues(context.Background(), time.Hour, true, time.Now())
	if fetches != 3 {
		t.Fatal("--refresh must fetch")
	}
	fail = true
	stale := linearIssues(context.Background(), 0, false, time.Now().Add(time.Second))
	if !stale.Stale || stale.Error == nil || *stale.Error != linearErrNetwork || stale.Issues[0].Identifier != "FIX-3" {
		t.Fatalf("stale fallback %+v", stale)
	}
	// A different generation (a new key) must never see the old list.
	env.keychain.key = linearStoredJSON(linearTestAPIKey, "api_key:other")
	other := linearIssues(context.Background(), time.Hour, false, time.Now())
	if len(other.Issues) != 0 || other.Error == nil || other.Stale {
		t.Fatalf("generation mismatch served old data: %+v", other)
	}
	_ = first
}

func TestLinearConcurrentIssuesFetchOnce(t *testing.T) {
	env := setupLinear(t)
	env.keychain.key = linearStoredJSON(linearTestAPIKey, "api_key:fixture")
	var mu sync.Mutex
	fetches := 0
	linearFetchIssues = func(_ context.Context, cred linearCred) (linearIssuesPayload, error) {
		mu.Lock()
		fetches++
		mu.Unlock()
		time.Sleep(100 * time.Millisecond)
		return linearIssuesPayload{Source: strPtr(cred.Source), Issues: []linearIssue{}}, nil
	}
	linearResolve(context.Background(), time.Now()) // record the generation once
	var wg sync.WaitGroup
	start := time.Now()
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			linearIssues(context.Background(), time.Minute, false, start)
		}()
	}
	wg.Wait()
	if fetches != 1 {
		t.Fatalf("lock + recheck should coalesce fetches, got %d", fetches)
	}
}

func TestLinearFileKeyStoreOnLinux(t *testing.T) {
	env := setupLinear(t)
	linearGOOS = "linux"
	ctx := context.Background()
	item := linearStoredKey{V: linearStoreVersion, APIKey: linearTestAPIKey, Generation: "api_key:fixture"}
	if err := linearStoreWrite(ctx, item); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(linearKeyFilePath())
	dir, _ := os.Stat(linearConfigDir())
	if err != nil || info.Mode().Perm() != 0600 || dir.Mode().Perm() != 0700 {
		t.Fatalf("modes %v %v", info.Mode(), dir.Mode())
	}
	raw, _ := os.ReadFile(linearKeyFilePath())
	if string(raw) != linearStoredJSON(linearTestAPIKey, "api_key:fixture") {
		t.Fatalf("file content is not the store item: %d bytes", len(raw))
	}
	if got, found, err := linearStoreLoad(ctx); err != nil || !found || got != item {
		t.Fatal("load")
	}
	if linearStoreDelete(ctx) != nil || linearStoreDelete(ctx) != nil {
		t.Fatal("delete must be idempotent")
	}
	if _, found, err := linearStoreLoad(ctx); err != nil || found {
		t.Fatal("a missing key file is no key, not an error")
	}
	if len(env.keychain.calls) != 0 {
		t.Fatal("linux must not use the keychain")
	}
}

func TestLinearKeychainCommands(t *testing.T) {
	env := setupLinear(t)
	ctx := context.Background()
	item := linearStoredKey{V: linearStoreVersion, APIKey: "k1", Generation: "api_key:g1"}
	if err := linearStoreWrite(ctx, item); err != nil {
		t.Fatal("store")
	}
	if got, found, err := linearStoreLoad(ctx); err != nil || !found || got != item {
		t.Fatal("load")
	}
	if err := linearStoreDelete(ctx); err != nil || linearStoreDelete(ctx) != nil {
		t.Fatal("delete idempotent")
	}
	want := [][]string{
		{"add-generic-password", "-s", "herdr-hud-linear", "-a", "default", "-U", "-w", `{"v":1,"api_key":"k1","generation":"api_key:g1"}`},
		{"find-generic-password", "-s", "herdr-hud-linear", "-a", "default", "-w"},
		{"delete-generic-password", "-s", "herdr-hud-linear", "-a", "default"},
		{"delete-generic-password", "-s", "herdr-hud-linear", "-a", "default"},
	}
	if !reflect.DeepEqual(env.keychain.calls, want) {
		t.Fatalf("calls %v", env.keychain.calls)
	}
}

func TestLinearUsageErrors(t *testing.T) {
	setupLinear(t)
	for _, args := range [][]string{{}, {"bogus"}, {"status", "x"}, {"issues", "--max-age", "-1s"}, {"connect", "--nope", linearTestAPIKey}, {"disconnect", "x"}} {
		code, stdout, stderr := linearRun(t, args...)
		if code != 2 || stdout != "" || !strings.Contains(stderr, "usage: herdr-hud linear") || strings.Contains(stderr, linearTestAPIKey) {
			t.Fatalf("%v: %d %q %q", args, code, stdout, stderr)
		}
	}
	var stderr bytes.Buffer
	if code := cmdHud([]string{"linear", "bogus"}, io.Discard, &stderr); code != 2 {
		t.Fatalf("cmdHud dispatch %d", code)
	}
}

// Every subcommand runs with known fake secrets; neither secret may appear in
// stdout, stderr or any file under the cache and config directories.
func TestLinearSecretsNeverLeak(t *testing.T) {
	env := setupLinear(t)
	env.claude = linearClaudeCreds(map[string]map[string]any{"linear|a": linearMCPCred(time.Now().Add(time.Hour).UnixMilli())})
	newFakeMCP(t)
	mcpTransport := linearHTTPTransport
	var output bytes.Buffer
	run := func(args ...string) {
		code, stdout, stderr := linearRun(t, args...)
		output.WriteString(fmt.Sprintf("%d%s%s", code, stdout, stderr))
	}
	run("status")
	run("issues", "--refresh")
	graphQLServer(t, linearDefaultGraphQL(t))
	run("connect", "--key", linearTestAPIKey)
	run("status")
	run("issues", "--refresh")
	run("issues")
	graphQLServer(t, func(_ string, _ map[string]any, w http.ResponseWriter) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"errors":[{"message":"bad key `+linearTestAPIKey+`"}]}`)
	})
	run("issues", "--refresh")
	run("connect", "--key", linearTestAPIKey+"x")
	run("connect", "--bogus", linearTestAPIKey)
	run("disconnect")
	linearHTTPTransport = mcpTransport
	run("issues", "--refresh")
	run("disconnect")
	for _, secret := range []string{linearTestAPIKey, linearTestMCPToken} {
		if strings.Contains(output.String(), secret) {
			t.Fatalf("secret leaked to output: %s", output.String())
		}
	}
	for _, root := range []string{env.config, env.cache} {
		_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return err
			}
			raw, _ := os.ReadFile(path)
			for _, secret := range []string{linearTestAPIKey, linearTestMCPToken} {
				if bytes.Contains(raw, []byte(secret)) {
					t.Fatalf("secret written to %s", path)
				}
			}
			return nil
		})
	}
}

func TestLinearNormalize(t *testing.T) {
	due := "2026-01-02"
	empty := ""
	for _, tc := range []struct {
		raw  linearRawIssue
		ok   bool
		prio int
	}{
		{linearRawIssue{Identifier: "AB1-9", URL: "https://linear.app/o/issue/AB1-9", StatusType: "Started", Priority: 2.4, DueDate: &due, Project: &empty}, true, 2},
		{linearRawIssue{Identifier: "AB-1", URL: "https://linear.app/x", StatusType: "unstarted", Priority: -1}, true, 0},
		{linearRawIssue{Identifier: "ab-1", URL: "https://linear.app/x", StatusType: "started"}, false, 0},
		{linearRawIssue{Identifier: "AB-1", URL: "http://linear.app/x", StatusType: "started"}, false, 0},
		{linearRawIssue{Identifier: "AB-1", URL: "https://linear.app/x", StatusType: "completed"}, false, 0},
		{linearRawIssue{Identifier: "AB-1", URL: "https://linear.app/x", StatusType: ""}, false, 0},
	} {
		got, ok := linearNormalize(tc.raw)
		if ok != tc.ok || (ok && (got.Priority != tc.prio || got.Project != nil || *got.TeamKey != strings.Split(tc.raw.Identifier, "-")[0])) {
			t.Fatalf("%+v → %+v %v", tc.raw, got, ok)
		}
	}
	if linearOrgURLFromURL("https://linear.app/acme/") != "https://linear.app/acme" || linearOrgURLFromURL("https://evil.example/acme") != "" {
		t.Fatal("org url")
	}
}
