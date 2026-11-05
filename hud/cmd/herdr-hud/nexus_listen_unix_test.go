//go:build darwin || linux

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
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
	}{
		{"startup", "status", "verified", "", "listening", false},
		{"no pid", "status", "", "", "idle", false},
		{"wrong identity status", "status", "other", "", "idle", false},
		{"dead stop", "stop", "dead", "listening", "idle", true},
		{"wrong identity stop", "stop", "other", "listening", "idle", true},
		{"preserve final", "stop", "dead", "final", "idle", false},
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
			got := nexusListenWith(context.Background(), tc.sub, "darwin", binary, dir)
			if got.State != tc.want || got.Level != 0 {
				t.Fatal(got)
			}
			if tc.sub == "stop" {
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
