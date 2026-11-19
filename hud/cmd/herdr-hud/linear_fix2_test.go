package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	linearBusyIssuesJSON = `{"source":null,"org_url":null,"fetched_at":null,"stale":false,"issues":[],"error":"busy"}`
	linearBusyStatusJSON = `{"connected":false,"source":null,"user":null,"org":null,"expires_at":null,"error":"busy"}`
)

func linearConnectOK(t *testing.T, key string) {
	t.Helper()
	if code, stdout, _ := linearRun(t, "connect", "--key", key); code != 0 {
		t.Fatalf("fixture connect: %d %s", code, stdout)
	}
}

func linearExpectOnly(t *testing.T, got linearIssuesPayload, want string) {
	t.Helper()
	if got.Error != nil || len(got.Issues) != 1 || got.Issues[0].Identifier != want {
		t.Fatalf("expected fixture issue %s, got %+v", want, got)
	}
}

func linearKeychainCalls(env *linearEnv) int {
	env.keychain.mu.Lock()
	defer env.keychain.mu.Unlock()
	return len(env.keychain.calls)
}

func linearLockPath() string { return filepath.Join(linearConfigDir(), "linear-credential.lock") }

// linearPauseStoreWrite blocks the next keychain store write until resume is
// closed. The connect that issues it holds the credential lock meanwhile.
func linearPauseStoreWrite(env *linearEnv) (entered, resume chan struct{}) {
	entered, resume = make(chan struct{}), make(chan struct{})
	var once sync.Once
	linearSecurityRun = func(ctx context.Context, args ...string) ([]byte, error) {
		if args[0] == "add-generic-password" {
			once.Do(func() {
				close(entered)
				<-resume
			})
		}
		return env.keychain.run(ctx, args...)
	}
	return entered, resume
}

// F10: an issues read that cannot open the credential lock while a connect is
// mid-write reports busy and touches neither the store, the cache nor meta.
func TestLinearIssuesBusyWhenCredentialLockUnavailable(t *testing.T) {
	env := setupLinear(t)
	linearViewerServer(t)
	linearFetchBySecret(t)
	linearConnectOK(t, linearTestAPIKey)
	linearExpectOnly(t, linearIssues(context.Background(), time.Minute, false, time.Now()), "A-1")
	cache, err := os.ReadFile(linearCachePath())
	if err != nil {
		t.Fatal(err)
	}
	metaA := linearMetaRaw(t)
	entered, resume := linearPauseStoreWrite(env)
	ctx := context.Background()
	connectResult := make(chan int, 1)
	go func() {
		_, code := linearConnect(ctx, linearTestAPIKeyB)
		connectResult <- code
	}()
	<-entered
	// The writer still owns the flock; a permission error stops new descriptors.
	if err := os.Chmod(linearLockPath(), 0400); err != nil {
		close(resume)
		<-connectResult
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(linearLockPath(), 0600) })
	calls := linearKeychainCalls(env)
	issues := linearIssues(ctx, 0, true, time.Now())
	status := linearStatus(ctx)
	callsAfter := linearKeychainCalls(env)
	cacheAfter, cacheErr := os.ReadFile(linearCachePath())
	metaAfter := linearMetaRaw(t)
	close(resume)
	code := <-connectResult
	_ = os.Chmod(linearLockPath(), 0600)
	if issues.Error == nil || *issues.Error != linearErrBusy || len(issues.Issues) != 0 || issues.Source != nil {
		t.Fatalf("expected busy issues without data, got %+v", issues)
	}
	if status.Connected || status.Source != nil || status.Error == nil || *status.Error != linearErrBusy {
		t.Fatalf("expected busy status, got %+v", status)
	}
	if callsAfter != calls {
		t.Fatal("busy readers must not read credentials")
	}
	if cacheErr != nil || string(cacheAfter) != string(cache) || metaAfter != metaA {
		t.Fatal("busy readers must not write the cache or meta")
	}
	if code != 0 || env.keychain.apiKey() != linearTestAPIKeyB {
		t.Fatal("connect B must commit once the write completes")
	}
	linearExpectOnly(t, linearIssues(ctx, time.Minute, false, time.Now()), "B-1")
}

// F10: status that times out waiting for a first connect reports busy instead
// of reading the store, and writes no meta.
func TestLinearStatusTimeoutReportsBusy(t *testing.T) {
	env := setupLinear(t)
	linearViewerServer(t)
	entered, resume := linearPauseStoreWrite(env)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	connectResult := make(chan int, 1)
	go func() {
		_, code := linearConnect(ctx, linearTestAPIKeyB)
		connectResult <- code
	}()
	<-entered
	out := linearStatus(ctx)
	_, metaErr := os.Stat(linearMetaFilePath())
	close(resume)
	code := <-connectResult
	if out.Connected || out.Source != nil || out.User != nil || out.Error == nil || *out.Error != linearErrBusy {
		t.Fatalf("expected busy status while connect holds the lock: %+v", out)
	}
	if !errors.Is(metaErr, os.ErrNotExist) {
		t.Fatalf("status must not write meta without the lock: %v", metaErr)
	}
	if code != 0 || env.keychain.apiKey() != linearTestAPIKeyB {
		t.Fatal("connect must commit once its write completes")
	}
	if after := linearStatus(ctx); !after.Connected || after.User == nil || after.User.Name != "Fixture Person" {
		t.Fatalf("expected later status to report the new key: %+v", after)
	}
}

// F10: the CLI prints the fixed busy payloads with exit 0.
func TestLinearBusyCLIPayloads(t *testing.T) {
	env := setupLinear(t)
	linearViewerServer(t)
	linearConnectOK(t, linearTestAPIKey)
	if err := os.Chmod(linearLockPath(), 0400); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(linearLockPath(), 0600) })
	calls := linearKeychainCalls(env)
	for args, want := range map[string]string{"issues": linearBusyIssuesJSON, "status": linearBusyStatusJSON} {
		code, stdout, stderr := linearRun(t, args)
		if code != 0 || strings.TrimSpace(stdout) != want || stderr != "" {
			t.Fatalf("%s: %d %q %q", args, code, stdout, stderr)
		}
	}
	if linearKeychainCalls(env) != calls {
		t.Fatal("busy commands must not read credentials")
	}
	if _, err := os.Stat(linearCachePath()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("busy issues must not write a cache")
	}
}
