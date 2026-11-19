package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const linearTestAPIKeyB = "lin_api_FAKESECRETkeyBBBBBBBBBB"

// linearFetchBySecret tags each fetched issue with the key that fetched it.
func linearFetchBySecret(t *testing.T) {
	t.Helper()
	linearFetchIssues = func(_ context.Context, cred linearCred) (linearIssuesPayload, error) {
		id := "UNKNOWN-1"
		switch cred.Secret {
		case linearTestAPIKey:
			id = "A-1"
		case linearTestAPIKeyB:
			id = "B-1"
		}
		return linearIssuesPayload{Source: strPtr(cred.Source), Issues: []linearIssue{{Identifier: id}}}, nil
	}
}

func linearViewerServer(t *testing.T) {
	t.Helper()
	graphQLServer(t, func(_ string, _ map[string]any, w http.ResponseWriter) {
		fmt.Fprint(w, linearFixture(t, "graphql_viewer.json"))
	})
}

// F1: an issues poll that read key A must not cache A's issues under the
// generation written by a concurrent connect of key B.
func TestLinearConnectDuringIssuesKeepsGenerationsApart(t *testing.T) {
	env := setupLinear(t)
	linearViewerServer(t)
	linearFetchBySecret(t)
	if code, out, _ := linearRun(t, "connect", "--key", linearTestAPIKey); code != 0 {
		t.Fatalf("connect A %s", out)
	}
	paused, resume := make(chan struct{}), make(chan struct{})
	var once sync.Once
	linearSecurityRun = func(ctx context.Context, args ...string) ([]byte, error) {
		out, err := env.keychain.run(ctx, args...)
		if args[0] == "find-generic-password" {
			first := false
			once.Do(func() { first = true })
			if first {
				close(paused)
				<-resume
			}
		}
		return out, err
	}
	var wg sync.WaitGroup
	var first linearIssuesPayload
	wg.Add(1)
	go func() {
		defer wg.Done()
		first = linearIssues(context.Background(), time.Minute, true, time.Now())
	}()
	<-paused
	connectCode := -1
	wg.Add(1)
	go func() {
		defer wg.Done()
		connectCode, _, _ = linearRun(t, "connect", "--key", linearTestAPIKeyB)
	}()
	time.Sleep(200 * time.Millisecond) // give connect B the chance to race
	close(resume)
	wg.Wait()
	if connectCode != 0 || env.keychain.key != linearTestAPIKeyB {
		t.Fatalf("connect B %d", connectCode)
	}
	if got := linearIdentifiers(first.Issues); len(got) != 1 || got[0] != "A-1" {
		t.Fatalf("first poll %v", got)
	}
	after := linearIssues(context.Background(), time.Hour, false, time.Now())
	if got := linearIdentifiers(after.Issues); len(got) != 1 || got[0] != "B-1" {
		t.Fatalf("account A's issues served under B's generation: %v", got)
	}
}

func linearMetaRaw(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(linearMetaFilePath())
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func linearAssertStillA(t *testing.T, env *linearEnv, metaBefore string) {
	t.Helper()
	if env.keychain.key != linearTestAPIKey {
		t.Fatal("the previously working key must survive a failed reconnect")
	}
	if linearMetaRaw(t) != metaBefore {
		t.Fatal("the previous metadata must survive a failed reconnect")
	}
	_, stdout, _ := linearRun(t, "status")
	if !strings.Contains(stdout, `"connected":true`) || !strings.Contains(stdout, `"source":"api_key"`) {
		t.Fatalf("status after failed reconnect %s", stdout)
	}
	entries, _ := os.ReadDir(linearConfigDir())
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".linear-meta.json-") {
			t.Fatalf("staged metadata left behind: %s", e.Name())
		}
	}
}

// F2: a failed reconnect never deletes the previously working key.
func TestLinearFailedReconnectKeepsPriorKey(t *testing.T) {
	t.Run("read-only metadata directory", func(t *testing.T) {
		env := setupLinear(t)
		linearViewerServer(t)
		if code, _, _ := linearRun(t, "connect", "--key", linearTestAPIKey); code != 0 {
			t.Fatal("connect A")
		}
		before := linearMetaRaw(t)
		if err := os.Chmod(linearConfigDir(), 0500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(linearConfigDir(), 0700) })
		code, stdout, _ := linearRun(t, "connect", "--key", linearTestAPIKeyB)
		if code != 1 || strings.TrimSpace(stdout) != `{"error":"store_failed"}` {
			t.Fatalf("connect B %d %s", code, stdout)
		}
		_ = os.Chmod(linearConfigDir(), 0700)
		linearAssertStillA(t, env, before)
	})
	t.Run("metadata rename fails after the key was stored", func(t *testing.T) {
		env := setupLinear(t)
		linearViewerServer(t)
		if code, _, _ := linearRun(t, "connect", "--key", linearTestAPIKey); code != 0 {
			t.Fatal("connect A")
		}
		before := linearMetaRaw(t)
		linearRename = func(string, string) error { return errors.New("rename failed") }
		code, stdout, _ := linearRun(t, "connect", "--key", linearTestAPIKeyB)
		if code != 1 || strings.TrimSpace(stdout) != `{"error":"store_failed"}` {
			t.Fatalf("connect B %d %s", code, stdout)
		}
		linearAssertStillA(t, env, before)
	})
	t.Run("keychain store fails", func(t *testing.T) {
		env := setupLinear(t)
		linearViewerServer(t)
		if code, _, _ := linearRun(t, "connect", "--key", linearTestAPIKey); code != 0 {
			t.Fatal("connect A")
		}
		before := linearMetaRaw(t)
		env.keychain.failStore = true
		if code, _, _ := linearRun(t, "connect", "--key", linearTestAPIKeyB); code != 1 {
			t.Fatal("connect B should fail")
		}
		env.keychain.failStore = false
		linearAssertStillA(t, env, before)
	})
	t.Run("rename fails with no previous key", func(t *testing.T) {
		env := setupLinear(t)
		linearViewerServer(t)
		linearRename = func(string, string) error { return errors.New("rename failed") }
		if code, _, _ := linearRun(t, "connect", "--key", linearTestAPIKeyB); code != 1 {
			t.Fatal("connect should fail")
		}
		if env.keychain.key != "" {
			t.Fatal("the new key must be removed when its metadata cannot be saved")
		}
		if _, err := os.Stat(linearMetaFilePath()); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("no metadata may be written")
		}
	})
}

// F3: a keychain failure other than "not found" is neither a missing key nor a
// successful disconnect, and it never falls through to the MCP token.
func TestLinearKeychainFailureIsNotMissing(t *testing.T) {
	env := setupLinear(t)
	env.keychain.key = linearTestAPIKey
	if err := linearMetaSave(linearMeta{Generation: "api_key:fixture", UserName: "Fixture Person"}); err != nil {
		t.Fatal(err)
	}
	env.claude = linearClaudeCreds(map[string]map[string]any{"linear|a": linearMCPCred(time.Now().Add(time.Hour).UnixMilli())})
	env.keychain.failAll = true
	code, stdout, _ := linearRun(t, "disconnect")
	if code != 1 || strings.TrimSpace(stdout) != `{"error":"store_failed"}` {
		t.Fatalf("disconnect %d %s", code, stdout)
	}
	if _, err := os.Stat(linearMetaFilePath()); err != nil {
		t.Fatal("metadata must be kept when the key could not be deleted")
	}
	if key, err := linearAPIKeyLoad(context.Background()); err == nil || key != "" {
		t.Fatal("a locked keychain must report an error, not an empty key")
	}
	_, stdout, _ = linearRun(t, "status")
	var status linearStatusPayload
	_ = json.Unmarshal([]byte(stdout), &status)
	if status.Connected || status.Source != nil || status.Error == nil || *status.Error != linearErrStoreFailed {
		t.Fatalf("status must not fall through to MCP: %s", stdout)
	}
	issues := linearIssues(context.Background(), time.Minute, false, time.Now())
	if issues.Error == nil || *issues.Error != linearErrStoreFailed || issues.Source != nil {
		t.Fatalf("issues %+v", issues)
	}
	env.keychain.failAll = false
	_, stdout, _ = linearRun(t, "status")
	if !strings.Contains(stdout, `"connected":true`) || !strings.Contains(stdout, `"source":"api_key"`) {
		t.Fatalf("status after access returns %s", stdout)
	}
}

// F4: a whoami failure during the issues fetch fails the fetch; nothing is
// newly cached and a same-generation cache is served stale.
func TestLinearWhoamiErrorFailsIssuesFetch(t *testing.T) {
	for _, mode := range []string{"rpc", "tool"} {
		t.Run(mode, func(t *testing.T) {
			env := setupLinear(t)
			env.claude = linearClaudeCreds(map[string]map[string]any{"linear|a": linearMCPCred(time.Now().Add(time.Hour).UnixMilli())})
			mcp := newFakeMCP(t)
			mcp.whoami = mode
			out := linearIssues(context.Background(), time.Minute, false, time.Now())
			if out.Error == nil || *out.Error != linearErrBadResponse || out.Stale || len(out.Issues) != 0 {
				t.Fatalf("whoami %s: %+v", mode, out)
			}
			if _, err := os.Stat(linearCachePath()); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("a failed fetch must not be cached")
			}
			mcp.mu.Lock()
			mcp.whoami = ""
			mcp.mu.Unlock()
			good := linearIssues(context.Background(), time.Minute, false, time.Now())
			if good.Error != nil || len(good.Issues) == 0 {
				t.Fatalf("baseline fetch %+v", good)
			}
			cached, _ := os.ReadFile(linearCachePath())
			mcp.mu.Lock()
			mcp.whoami = mode
			mcp.mu.Unlock()
			stale := linearIssues(context.Background(), time.Minute, true, time.Now().Add(time.Second))
			if stale.Error == nil || *stale.Error != linearErrBadResponse || !stale.Stale || len(stale.Issues) != len(good.Issues) {
				t.Fatalf("stale fallback %+v", stale)
			}
			if again, _ := os.ReadFile(linearCachePath()); string(again) != string(cached) {
				t.Fatal("the cache must not be rewritten by a failed fetch")
			}
		})
	}
}

// F5: an SSE event that ends past the 4 MiB cap is rejected even when it holds
// the matching response; an event ending exactly at the cap is accepted.
func TestLinearSSERejectsMatchingEventPastLimit(t *testing.T) {
	event := `data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}` + "\n\n"
	pad := func(n int) string { return ":" + strings.Repeat("x", n-2) + "\n" }
	over := pad(linearMaxBody-10) + event
	if _, err := linearSSEFind(strings.NewReader(over), 1); linearCode(err) != linearErrBadResponse {
		t.Fatalf("over-limit event accepted: %v", err)
	}
	// The data line's CR lands on the last allowed byte and its LF beyond it.
	crlf := `data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}` + "\r"
	split := pad(linearMaxBody-len(crlf)) + crlf + "\n\r\n"
	if _, err := linearSSEFind(strings.NewReader(split), 1); linearCode(err) != linearErrBadResponse {
		t.Fatalf("split CRLF event accepted: %v", err)
	}
	exact := pad(linearMaxBody-len(event)) + event
	if len(exact) != linearMaxBody {
		t.Fatalf("fixture length %d", len(exact))
	}
	if msg, err := linearSSEFind(strings.NewReader(exact), 1); err != nil || string(msg.Result) != `{"ok":true}` {
		t.Fatalf("event at the cap rejected: %v", err)
	}
}

// P1: the MCP generation changes when the OAuth entry's expiresAt changes.
func TestLinearMCPGenerationIncludesExpiry(t *testing.T) {
	now := time.Now()
	gen := func(exp int64) string {
		cred, found, _ := linearMCPEntry(linearClaudeCreds(map[string]map[string]any{"linear|a": linearMCPCred(exp)}), now)
		if !found {
			t.Fatal("entry not found")
		}
		return cred.Generation
	}
	a, b := gen(now.Add(time.Hour).UnixMilli()), gen(now.Add(2*time.Hour).UnixMilli())
	if a == b || a != fmt.Sprintf("claude_mcp:linear|a:client-1:%d", now.Add(time.Hour).UnixMilli()) {
		t.Fatalf("generations %s %s", a, b)
	}
	if strings.Contains(a, linearTestMCPToken) {
		t.Fatal("the generation must not contain the token")
	}
}

// Decision 19: the Linear path's file fallback honors CLAUDE_CONFIG_DIR; the
// usage path keeps reading the default Claude home.
func TestLinearClaudeConfigDirFallback(t *testing.T) {
	env := setupLinear(t)
	linearClaudeRaw = linearClaudeCredentialsRaw
	var services []string
	hudClaudeKeychainRead = func(_ context.Context, service string) ([]byte, error) {
		services = append(services, service)
		return nil, errKeychainMissing
	}
	exp := time.Now().Add(time.Hour).UnixMilli()
	creds := linearClaudeCreds(map[string]map[string]any{"linear|cfg": linearMCPCred(exp)})
	cfg := t.TempDir()
	if err := os.WriteFile(filepath.Join(cfg, ".credentials.json"), creds, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLAUDE_CONFIG_DIR", cfg)
	cred, code := linearResolve(context.Background(), time.Now())
	if code != "" || cred.Source != linearSourceClaudeMCP || !strings.HasPrefix(cred.Generation, "claude_mcp:linear|cfg:") {
		t.Fatalf("CLAUDE_CONFIG_DIR not honored: %s %s", cred, code)
	}
	if len(services) == 0 || services[0] != hudClaudeKeychainService {
		t.Fatalf("keychain lookup %v", services)
	}
	if raw, _ := hudClaudeCredentialsRaw(context.Background(), ""); len(raw) != 0 {
		t.Fatal("the usage path must keep ignoring CLAUDE_CONFIG_DIR")
	}
	home, _ := os.UserHomeDir()
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0700); err != nil {
		t.Fatal(err)
	}
	homeCreds := linearClaudeCreds(map[string]map[string]any{"linear|home": linearMCPCred(exp)})
	if err := os.WriteFile(filepath.Join(home, ".claude", ".credentials.json"), homeCreds, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	if cred, _ := linearResolve(context.Background(), time.Now()); !strings.HasPrefix(cred.Generation, "claude_mcp:linear|home:") {
		t.Fatalf("default home fallback %s", cred.Generation)
	}
	_ = env
}
