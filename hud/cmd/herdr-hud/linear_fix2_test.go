package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
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

// F9: when both the meta rename and the rollback of the previous key fail,
// key B must never be served with A's generation or A's cached issues.
func TestLinearRollbackFailureNeverPairsBWithACache(t *testing.T) {
	env := setupLinear(t)
	linearViewerServer(t)
	linearFetchBySecret(t)
	linearConnectOK(t, linearTestAPIKey)
	linearExpectOnly(t, linearIssues(context.Background(), time.Minute, false, time.Now()), "A-1")
	metaA := linearMetaRaw(t)
	linearRename = func(string, string) error {
		env.keychain.failStore = true
		return errors.New("fixture metadata rename failed")
	}
	code, out, stderr := linearRun(t, "connect", "--key", linearTestAPIKeyB)
	if code != 1 || strings.TrimSpace(out) != `{"error":"store_failed"}` || stderr != "" {
		t.Fatalf("unexpected failure result: %d %q %q", code, out, stderr)
	}
	env.keychain.failStore = false
	linearRename = os.Rename
	if _, err := os.Stat(linearCachePath()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the issues cache must be deleted after a failed replacement: %v", err)
	}
	for _, refresh := range []bool{false, true} {
		got := linearIssues(context.Background(), time.Minute, refresh, time.Now())
		for _, issue := range got.Issues {
			if issue.Identifier == "A-1" {
				t.Fatalf("A's issues served after failed reconnect (refresh=%v): %+v", refresh, got)
			}
		}
	}
	status := linearStatus(context.Background())
	switch {
	case env.keychain.key == linearTestAPIKey:
		if !status.Connected || linearMetaRaw(t) != metaA {
			t.Fatalf("rollback kept A but status/meta disagree: %+v", status)
		}
	case env.keychain.key == "":
		if status.Connected || status.Error == nil || *status.Error != linearErrNotConnected {
			t.Fatalf("expected not_connected after failed rollback: %+v", status)
		}
	default:
		t.Fatal("key B must not survive a failed rollback")
	}
}

// F9: when rollback succeeds, A keeps its generation but the cache is dropped.
func TestLinearRollbackSuccessDropsCache(t *testing.T) {
	env := setupLinear(t)
	linearViewerServer(t)
	linearFetchBySecret(t)
	linearConnectOK(t, linearTestAPIKey)
	linearExpectOnly(t, linearIssues(context.Background(), time.Minute, false, time.Now()), "A-1")
	metaA := linearMetaRaw(t)
	linearRename = func(string, string) error { return errors.New("fixture metadata rename failed") }
	if code, _, _ := linearRun(t, "connect", "--key", linearTestAPIKeyB); code != 1 {
		t.Fatal("connect B should fail")
	}
	if _, err := os.Stat(linearCachePath()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the issues cache must be deleted after a failed replacement: %v", err)
	}
	if env.keychain.key != linearTestAPIKey || linearMetaRaw(t) != metaA {
		t.Fatal("rollback must restore key A with A's generation")
	}
	linearExpectOnly(t, linearIssues(context.Background(), time.Minute, false, time.Now()), "A-1")
}

// F10: an issues read that cannot open the credential lock while a connect is
// mid-replacement reports busy and never sees the provisional key.
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
	renameEntered, resumeRename := make(chan struct{}), make(chan struct{})
	linearRename = func(string, string) error {
		close(renameEntered)
		<-resumeRename
		return errors.New("fixture metadata rename failed")
	}
	ctx := context.Background()
	connectResult := make(chan int, 1)
	go func() {
		_, code := linearConnect(ctx, linearTestAPIKeyB)
		connectResult <- code
	}()
	<-renameEntered
	// The writer still owns the flock; a permission error stops new descriptors.
	if err := os.Chmod(linearLockPath(), 0400); err != nil {
		close(resumeRename)
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
	close(resumeRename)
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
	if code != 1 || env.keychain.key != linearTestAPIKey {
		t.Fatal("connect B must fail and restore key A")
	}
}

// F10: status that times out waiting for a first connect reports busy instead
// of the uncommitted key, and writes no meta.
func TestLinearStatusTimeoutReportsBusy(t *testing.T) {
	env := setupLinear(t)
	linearViewerServer(t)
	renameEntered, resumeRename := make(chan struct{}), make(chan struct{})
	linearRename = func(string, string) error {
		close(renameEntered)
		<-resumeRename
		return errors.New("fixture metadata rename failed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	connectResult := make(chan int, 1)
	go func() {
		_, code := linearConnect(ctx, linearTestAPIKeyB)
		connectResult <- code
	}()
	<-renameEntered
	out := linearStatus(ctx)
	_, metaErr := os.Stat(linearMetaFilePath())
	close(resumeRename)
	code := <-connectResult
	if out.Connected || out.Source != nil || out.User != nil || out.Error == nil || *out.Error != linearErrBusy {
		t.Fatalf("expected busy status while connect holds the lock: %+v", out)
	}
	if !errors.Is(metaErr, os.ErrNotExist) {
		t.Fatalf("status must not write meta without the lock: %v", metaErr)
	}
	if code != 1 || env.keychain.key != "" {
		t.Fatal("connect must fail and remove the provisional key")
	}
	if after := linearStatus(ctx); after.Connected || after.Error == nil || *after.Error != linearErrNotConnected {
		t.Fatalf("expected later status to report not connected: %+v", after)
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
