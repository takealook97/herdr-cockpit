//go:build darwin || linux

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestNexusListenUnavailable(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		for _, sub := range []string{"start", "stop", "status"} {
			got := nexusListenWith(context.Background(), sub, goos, filepath.Join(t.TempDir(), "missing"), t.TempDir())
			if got.State != "unavailable" {
				t.Fatal(got)
			}
		}
	}
}
func TestNexusListenStatus(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "herdr-listen")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\n"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ raw, want string }{{`{"state":"final","final":"hello"}`, "final"}, {`{"state":"listening","pid":99999999}`, "error"}, {`{"state":"invalid"}`, "error"}, {`{`, "error"}} {
		if err := os.WriteFile(filepath.Join(dir, "listen.json"), []byte(tc.raw), 0600); err != nil {
			t.Fatal(err)
		}
		got := nexusListenWith(context.Background(), "status", "darwin", binary, dir)
		if got.State != tc.want {
			t.Fatal(got)
		}
	}
}

func TestNexusListenPIDFallbackAndCleanup(t *testing.T) {
	for _, tc := range []struct {
		name, sub, pidKind, state, want string
		removed                         bool
		scoped                          int
		preserve                        bool
	}{
		{"start pid", "start", "", "", "listening", false, 0, false},
		{"scoped mismatch", "stop", "verified", "listening", "listening", false, -1, true},
		{"scoped dead mismatch", "stop", "dead", "listening", "error", false, -1, true},
		{"scoped missing", "stop", "", "listening", "error", false, -1, true},
		{"scoped unverified", "stop", "other", "listening", "error", false, 1, true},
		{"scoped matching", "stop", "verified", "listening", "idle", false, 1, false},
		{"scoped dead matching", "stop", "dead", "listening", "idle", true, 1, false},
		{"startup", "status", "verified", "", "listening", false, 0, false},
		{"no pid", "status", "", "", "idle", false, 0, false},
		{"wrong identity status", "status", "other", "", "idle", false, 0, false},
		{"dead stop", "stop", "dead", "listening", "idle", true, 0, false},
		{"wrong identity stop", "stop", "other", "listening", "idle", true, 0, false},
		{"preserve final", "stop", "dead", "final", "idle", false, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			binary := filepath.Join(dir, "herdr-listen")
			// Compile a native helper: copying a platform-signed executable can
			// invalidate its signature on macOS.
			build := exec.Command("cc", "-x", "c", "-", "-o", binary)
			build.Stdin = strings.NewReader("#include <unistd.h>\nint main(void) { sleep(30); return 0; }\n")
			if raw, err := build.CombinedOutput(); err != nil {
				t.Fatalf("build listener: %v: %s", err, raw)
			}
			var process *exec.Cmd
			pid := 99999999
			if tc.pidKind == "verified" || tc.pidKind == "other" {
				path := binary
				if tc.pidKind == "other" {
					path = "/bin/sleep"
				}
				cmd := exec.Command(path, "30")
				if err := cmd.Start(); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
				process = cmd
				pid = cmd.Process.Pid
				if tc.pidKind == "verified" {
					deadline := time.Now().Add(2 * time.Second)
					for {
						raw, err := exec.Command("ps", "-o", "comm=", "-p", strconv.Itoa(pid)).Output()
						if err == nil && filepath.Base(strings.TrimSpace(string(raw))) == "herdr-listen" {
							break
						}
						if time.Now().After(deadline) {
							t.Fatalf("listener identity not ready: %q (%v)", raw, err)
						}
						time.Sleep(10 * time.Millisecond)
					}
				}
			}
			pidPath := filepath.Join(dir, "listen.pid")
			if tc.pidKind != "" {
				if err := os.WriteFile(pidPath, []byte(strconv.Itoa(pid)), 0600); err != nil {
					t.Fatal(err)
				}
			}
			statePath := filepath.Join(dir, "listen.json")
			if tc.state != "" {
				if err := os.WriteFile(statePath, []byte(fmt.Sprintf(`{"state":%q}`, tc.state)), 0600); err != nil {
					t.Fatal(err)
				}
			}
			var expected []int
			if tc.scoped != 0 {
				expected = []int{pid}
				if tc.scoped < 0 {
					expected[0]++
				}
			}
			got := nexusListenWith(context.Background(), tc.sub, "darwin", binary, dir, expected...)
			if tc.sub == "start" {
				if got.PID <= 0 {
					t.Fatal("start omitted pid", got)
				}
				t.Cleanup(func() { _ = syscall.Kill(got.PID, syscall.SIGKILL) })
				raw, _ := json.Marshal(got)
				var reply map[string]any
				_ = json.Unmarshal(raw, &reply)
				if reply["pid"] != float64(got.PID) {
					t.Fatal(string(raw))
				}
			}
			if tc.preserve {
				if tc.pidKind != "" {
					raw, err := os.ReadFile(pidPath)
					if err != nil || string(raw) != strconv.Itoa(pid) {
						t.Fatal("pid changed", string(raw), err)
					}
				}
				raw, err := os.ReadFile(statePath)
				if err != nil || string(raw) != fmt.Sprintf(`{"state":%q}`, tc.state) {
					t.Fatal("state changed", string(raw), err)
				}
				if process != nil && syscall.Kill(pid, 0) != nil {
					t.Fatal("mismatched process was signaled")
				}
			}
			if tc.scoped > 0 && tc.pidKind == "verified" {
				done := make(chan error, 1)
				go func() { done <- process.Wait() }()
				select {
				case err := <-done:
					exit, ok := err.(*exec.ExitError)
					if !ok || exit.Sys().(syscall.WaitStatus).Signal() != syscall.SIGTERM {
						t.Fatalf("not terminated: %v", err)
					}
				case <-time.After(2 * time.Second):
					t.Fatal("matching stop did not signal")
				}
			}
			if tc.sub == "status" && tc.pidKind == "verified" && got.PID != pid {
				t.Fatal("missing status pid", got)
			}
			if got.State != tc.want || got.Level != 0 {
				t.Fatal(got)
			}
			if tc.sub == "stop" && !tc.preserve {
				if _, err := os.Stat(pidPath); !os.IsNotExist(err) {
					t.Fatalf("pid not removed: %v", err)
				}
				_, err := os.Stat(statePath)
				if os.IsNotExist(err) != tc.removed {
					t.Fatalf("state removed=%v, want %v", os.IsNotExist(err), tc.removed)
				}
			}
		})
	}
}

func TestNexusListenStatusKnownPID(t *testing.T) {
	for _, tc := range []struct {
		name, state, pidFile string
		want                 int
	}{
		{"state pid", `{"state":"final","pid":123}`, "456", 123},
		{"file pid", `{"state":"final"}`, "456", 456},
		{"missing state", "", "456", 456},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			binary := filepath.Join(dir, "herdr-listen")
			if err := os.WriteFile(binary, []byte("#!/bin/sh\n"), 0700); err != nil {
				t.Fatal(err)
			}
			if tc.state != "" {
				if err := os.WriteFile(filepath.Join(dir, "listen.json"), []byte(tc.state), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(filepath.Join(dir, "listen.pid"), []byte(tc.pidFile), 0600); err != nil {
				t.Fatal(err)
			}
			got := nexusListenWith(context.Background(), "status", "darwin", binary, dir)
			if got.PID != tc.want {
				t.Fatal(got)
			}
		})
	}
}
