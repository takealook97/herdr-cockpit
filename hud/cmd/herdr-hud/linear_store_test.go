package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

const linearStoreFailedStatusJSON = `{"connected":false,"source":null,"user":null,"org":null,"expires_at":null,"error":"store_failed"}`
const linearStoreFailedIssuesJSON = `{"source":null,"org_url":null,"fetched_at":null,"stale":false,"issues":[],"error":"store_failed"}`

// linearNeverA fails if any issues read returns account A's fixture payload.
func linearNeverA(t *testing.T, got linearIssuesPayload, when string) {
	t.Helper()
	for _, issue := range got.Issues {
		if issue.Identifier == "A-1" {
			t.Fatalf("A's issues served while B is active (%s): %+v", when, got)
		}
	}
}

// linearConnectedA connects key A and caches A-1 under A's generation.
func linearConnectedA(t *testing.T) *linearEnv {
	t.Helper()
	env := setupLinear(t)
	linearViewerServer(t)
	linearFetchBySecret(t)
	linearConnectOK(t, linearTestAPIKey)
	linearExpectOnly(t, linearIssues(context.Background(), time.Minute, false, time.Now()), "A-1")
	return env
}

// Ported from recrit2: a command context canceled around the store write. A
// canceled write changes nothing; a write that committed before the cancel is
// fully effective, and A's cache is never served for B.
func TestLinearCanceledConnectNeverServesACache(t *testing.T) {
	for _, cancelAfterWrite := range []bool{false, true} {
		t.Run(fmt.Sprintf("cancel_after_write=%v", cancelAfterWrite), func(t *testing.T) {
			env := linearConnectedA(t)
			itemA := env.keychain.key
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			linearSecurityRun = func(ctx context.Context, args ...string) ([]byte, error) {
				if args[0] == "add-generic-password" && !cancelAfterWrite {
					cancel()
				}
				if err := ctx.Err(); err != nil {
					return nil, err // exec.CommandContext will not start security in this state.
				}
				out, err := env.keychain.run(ctx, args...)
				if args[0] == "add-generic-password" && cancelAfterWrite {
					cancel()
				}
				return out, err
			}
			out, code := linearConnect(ctx, linearTestAPIKeyB)
			linearSecurityRun = env.keychain.run
			if !cancelAfterWrite {
				if code != 1 || out != (linearErrorPayload{linearErrStoreFailed}) || env.keychain.key != itemA {
					t.Fatalf("canceled write must change nothing: %v %d", out, code)
				}
				linearExpectOnly(t, linearIssues(context.Background(), time.Minute, false, time.Now()), "A-1")
				return
			}
			if code != 0 || env.keychain.apiKey() != linearTestAPIKeyB {
				t.Fatalf("committed write must report success: %v %d", out, code)
			}
			if _, err := os.Stat(linearCachePath()); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("A's cache must be dropped after B committed: %v", err)
			}
			for _, refresh := range []bool{false, true} {
				got := linearIssues(context.Background(), time.Minute, refresh, time.Now())
				linearNeverA(t, got, fmt.Sprintf("refresh=%v", refresh))
				linearExpectOnly(t, got, "B-1")
			}
		})
	}
}

// Ported from recrit2: every best-effort step after the store write fails
// (cache and meta cannot be removed or written). B is active with its own
// generation, A's cache is never served and A's identity is never shown.
func TestLinearFailedCleanupNeverServesACache(t *testing.T) {
	env := linearConnectedA(t)
	for _, dir := range []string{linearConfigDir(), hudCacheDir()} {
		if err := os.Chmod(dir, 0500); err != nil {
			t.Fatal(err)
		}
		d := dir
		t.Cleanup(func() { _ = os.Chmod(d, 0700) })
	}
	metaA := linearMetaRaw(t)
	code, stdout, stderr := linearRun(t, "connect", "--key", linearTestAPIKeyB)
	if code != 0 || stderr != "" || env.keychain.apiKey() != linearTestAPIKeyB {
		t.Fatalf("connect B must commit despite failed cleanup: %d %q %q", code, stdout, stderr)
	}
	if _, err := os.Stat(linearCachePath()); err != nil || linearMetaRaw(t) != metaA {
		t.Fatal("fixture expected the cache and A's meta to survive")
	}
	for _, refresh := range []bool{false, true} {
		got := linearIssues(context.Background(), time.Minute, refresh, time.Now())
		linearNeverA(t, got, fmt.Sprintf("read-only, refresh=%v", refresh))
		linearExpectOnly(t, got, "B-1")
	}
	status := linearStatus(context.Background())
	if !status.Connected || status.User != nil || status.Org != nil {
		t.Fatalf("A's metadata must not describe B: %+v", status)
	}
	for _, dir := range []string{linearConfigDir(), hudCacheDir()} {
		_ = os.Chmod(dir, 0700)
	}
	linearExpectOnly(t, linearIssues(context.Background(), time.Minute, false, time.Now()), "B-1")
}

// A store write failure prints only the fixed code, even when the failing
// command's error carries the key.
func TestLinearStoreWriteFailureIsFixedCode(t *testing.T) {
	env := linearConnectedA(t)
	itemA := env.keychain.key
	linearSecurityRun = func(ctx context.Context, args ...string) ([]byte, error) {
		if args[0] == "add-generic-password" {
			return nil, errors.New("fake Keychain failure containing " + linearTestAPIKeyB)
		}
		return env.keychain.run(ctx, args...)
	}
	code, stdout, stderr := linearRun(t, "connect", "--key", linearTestAPIKeyB)
	if code != 1 || strings.TrimSpace(stdout) != `{"error":"store_failed"}` || stderr != "" {
		t.Fatalf("got %d %q %q", code, stdout, stderr)
	}
	if env.keychain.key != itemA {
		t.Fatal("a failed write must leave the store item unchanged")
	}
	linearExpectOnly(t, linearIssues(context.Background(), time.Minute, false, time.Now()), "A-1")
}

// Ported P2: macOS shares one keychain item across XDG profiles. After profile
// B connects key B, profile A reads B's generation from the item and never
// serves A's cache or shows A's identity.
func TestLinearDarwinProfilesNeverPairKeyWithOtherGeneration(t *testing.T) {
	env := linearConnectedA(t)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	linearConnectOK(t, linearTestAPIKeyB)
	linearExpectOnly(t, linearIssues(context.Background(), time.Minute, false, time.Now()), "B-1")
	t.Setenv("XDG_CONFIG_HOME", env.config)
	t.Setenv("XDG_CACHE_HOME", env.cache)
	got := linearIssues(context.Background(), time.Minute, false, time.Now())
	linearNeverA(t, got, "profile A after profile B connected")
	linearExpectOnly(t, got, "B-1")
	if status := linearStatus(context.Background()); !status.Connected || status.User != nil || status.Org != nil {
		t.Fatalf("profile A's metadata must not describe key B: %+v", status)
	}
}

// Meta is shown only when its generation equals the store item's.
func TestLinearMetaGenerationMismatchHidesIdentity(t *testing.T) {
	env := setupLinear(t)
	meta := linearMeta{Generation: "api_key:meta", UserName: "Fixture Person", OrgName: "Fixture Org", OrgURL: "https://linear.app/fixture"}
	if err := linearMetaSave(meta); err != nil {
		t.Fatal(err)
	}
	env.keychain.key = linearStoredJSON(linearTestAPIKey, "api_key:item")
	status := linearStatus(context.Background())
	if !status.Connected || status.User != nil || status.Org != nil {
		t.Fatalf("mismatched meta must yield null user/org: %+v", status)
	}
	env.keychain.key = linearStoredJSON(linearTestAPIKey, "api_key:meta")
	status = linearStatus(context.Background())
	if status.User == nil || status.User.Name != "Fixture Person" || status.Org == nil || status.Org.URL != "https://linear.app/fixture" {
		t.Fatalf("matching meta must be shown: %+v", status)
	}
	raw := linearMetaRaw(t)
	if strings.Contains(raw, linearTestAPIKey) {
		t.Fatal("meta must not contain the key")
	}
}

// A malformed item or a store read failure is store_failed for both readers,
// never a fallthrough to the Claude MCP token.
func TestLinearMalformedOrUnreadableStoreFailsClosed(t *testing.T) {
	cases := map[string]func(env *linearEnv){
		"not json":       func(env *linearEnv) { env.keychain.key = linearTestAPIKey },
		"wrong version":  func(env *linearEnv) { env.keychain.key = `{"v":2,"api_key":"k","generation":"api_key:g"}` },
		"empty key":      func(env *linearEnv) { env.keychain.key = linearStoredJSON("", "api_key:g") },
		"bad generation": func(env *linearEnv) { env.keychain.key = linearStoredJSON(linearTestAPIKey, "claude_mcp:x") },
		"read failure": func(env *linearEnv) {
			env.keychain.key = linearStoredJSON(linearTestAPIKey, "api_key:g")
			env.keychain.failAll = true
		},
		"linux malformed file": func(env *linearEnv) {
			linearGOOS = "linux"
			if err := hudWritePrivateFile(linearKeyFilePath(), []byte(`{"api_key":"k"}`)); err != nil {
				panic(err)
			}
		},
		"linux unreadable file": func(env *linearEnv) {
			linearGOOS = "linux"
			if err := os.MkdirAll(linearKeyFilePath(), 0700); err != nil { // a directory cannot be read as a file
				panic(err)
			}
		},
	}
	for name, arrange := range cases {
		t.Run(name, func(t *testing.T) {
			env := setupLinear(t)
			env.claude = linearClaudeCreds(map[string]map[string]any{"linear|a": linearMCPCred(time.Now().Add(time.Hour).UnixMilli())})
			arrange(env)
			for args, want := range map[string]string{"status": linearStoreFailedStatusJSON, "issues": linearStoreFailedIssuesJSON} {
				code, stdout, stderr := linearRun(t, args)
				if code != 0 || strings.TrimSpace(stdout) != want || stderr != "" {
					t.Fatalf("%s: %d %q %q", args, code, stdout, stderr)
				}
			}
		})
	}
}

// The store item and the resolved credential redact the key when formatted.
func TestLinearStoredKeyRedacts(t *testing.T) {
	item := linearStoredKey{V: linearStoreVersion, APIKey: linearTestAPIKey, Generation: "api_key:g"}
	for _, s := range []string{fmt.Sprintf("%v %+v %#v %s", item, item, item, item), fmt.Sprint([]linearStoredKey{item})} {
		if strings.Contains(s, linearTestAPIKey) || !strings.Contains(s, "api_key:g") {
			t.Fatalf("formatting must redact the key and keep the generation: %s", s)
		}
	}
}
