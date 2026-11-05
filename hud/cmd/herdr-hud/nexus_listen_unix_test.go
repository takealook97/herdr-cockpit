//go:build darwin || linux

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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

func TestNexusListenLaughStatus(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "herdr-listen")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "listen.json"), []byte(`{"state":"final","final":"테스트","laughing":true,"trimmed":2}`), 0600); err != nil {
		t.Fatal(err)
	}
	got := nexusListenWith(context.Background(), "status", "darwin", binary, dir)
	if !got.Laughing || got.Trimmed != 2 || got.Final != "테스트" {
		t.Fatal(got)
	}
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	if fields["laughing"] != true || fields["trimmed"] != float64(2) {
		t.Fatal(string(raw))
	}
	raw, _ = json.Marshal(nexusListenState{State: "idle"})
	if strings.Contains(string(raw), "laughing") || strings.Contains(string(raw), "trimmed") {
		t.Fatal(string(raw))
	}
}

func TestNexusListenAudioArgs(t *testing.T) {
	for _, tc := range []struct {
		cfg  nexusConfig
		want string
	}{
		{nexusConfig{}, "--state /tmp/listen.json"},
		{nexusConfig{KeepAudio: 2, LaughThreshold: 0.7}, "--state /tmp/listen.json --keep-audio 2 --laugh-threshold 0.7"},
		{nexusConfig{KeepAudio: 100, LaughThreshold: 0.1}, "--state /tmp/listen.json --keep-audio 100 --laugh-threshold 0.1"},
		{nexusConfig{KeepAudio: -1, LaughThreshold: 1}, "--state /tmp/listen.json"},
		{nexusConfig{KeepAudio: 101, LaughThreshold: 0.09}, "--state /tmp/listen.json"},
	} {
		if got := strings.Join(nexusListenArgs("/tmp/listen.json", tc.cfg), " "); got != tc.want {
			t.Fatalf("%+v: %s", tc.cfg, got)
		}
	}
}

func TestNexusListenStatusUsesVerifiedProxyPID(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "herdr-listen")
	build := exec.Command("cc", "-x", "c", "-", "-o", binary)
	build.Stdin = strings.NewReader("#include <unistd.h>\nint main(void) { sleep(30); return 0; }\n")
	if raw, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build listener: %v: %s", err, raw)
	}
	cmd := exec.Command(binary)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	pid := cmd.Process.Pid
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
	// A verified preparation process is reused without launching or rewriting its PID.
	preparePID := filepath.Join(dir, "listen-prepare.pid")
	originalPID := []byte(strconv.Itoa(pid))
	if err := os.WriteFile(preparePID, originalPID, 0600); err != nil {
		t.Fatal(err)
	}
	gotPrepare := nexusListenPrepareWith(context.Background(), "darwin", binary, dir, time.Now)
	if gotPrepare["state"] != "preparing" {
		t.Fatal(gotPrepare)
	}
	if raw, err := os.ReadFile(preparePID); err != nil || !bytes.Equal(raw, originalPID) {
		t.Fatalf("PID changed: %q, %v", raw, err)
	}

	if err := os.WriteFile(filepath.Join(dir, "listen.pid"), []byte(strconv.Itoa(pid)), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "listen.json"), []byte(`{"state":"listening","pid":99999999,"partial":"hello"}`), 0600); err != nil {
		t.Fatal(err)
	}
	got := nexusListenWith(context.Background(), "status", "darwin", binary, dir)
	if got.State != "listening" || got.PID != pid || got.Partial != "hello" {
		t.Fatal(got)
	}
}

func TestNexusListenHintsAndEngine(t *testing.T) {
	raw := []byte(`{"SpEeChEnGiNe":"ANALYZER","SERVERSPEECH":true,"model":"claude-medium-m"}`)
	cfg := nexusParseConfig(raw)
	if cfg.SpeechEngine != "analyzer" || !cfg.ServerSpeech || cfg.Model != "claude-medium-m" {
		t.Fatal(cfg)
	}
	args := nexusListenArgs("/tmp/state", cfg, " wiki-island,온톨로지,wiki-island,,"+strings.Repeat("가", 65)+",bad\x00hint")
	want := "--state /tmp/state --engine analyzer --server --hints wiki-island,온톨로지"
	if strings.Join(args, " ") != want {
		t.Fatal(args)
	}
	if c := nexusParseConfig([]byte(`{"speechEngine":false,"serverSpeech":"true","keepAudio":2}`)); c.SpeechEngine != "" || c.ServerSpeech || c.KeepAudio != 2 {
		t.Fatal(c)
	}
	many := []string{}
	for i := 0; i < 110; i++ {
		many = append(many, fmt.Sprintf("head-%d", i))
	}
	if n := len(strings.Split(nexusListenHints(strings.Join(many, ",")), ",")); n != 100 {
		t.Fatal(n)
	}
}

func TestNexusListenEndReason(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "herdr-listen")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "listen.json"), []byte(`{"state":"final","final":"테스트","endReason":"silence","engine":"analyzer"}`), 0600); err != nil {
		t.Fatal(err)
	}
	got := nexusListenWith(context.Background(), "status", "darwin", binary, dir)
	if got.EndReason != "silence" || got.Engine != "analyzer" {
		t.Fatal(got)
	}
	raw, _ := json.Marshal(got)
	if !strings.Contains(string(raw), `"end_reason":"silence"`) {
		t.Fatal(string(raw))
	}
}

// Exercise cmdNexus all the way through listener process creation, so a flag
// accepted by the parser but dropped on the way to argv fails this test.
func TestCmdNexusListenStartForwardsHints(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("listener launch is macOS-only")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	argsPath := filepath.Join(home, "args")
	t.Setenv("NEXUS_TEST_LISTENER_ARGS", argsPath)
	binary := filepath.Join(home, ".local", "bin", "herdr-listen")
	if err := os.MkdirAll(filepath.Dir(binary), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$NEXUS_TEST_LISTENER_ARGS\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	if code := cmdNexus([]string{"listen", "start", "--hints", "wiki-island,온톨로지"}, &out, &stderr); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	var state nexusListenState
	if err := json.Unmarshal(out.Bytes(), &state); err != nil || state.State != "listening" || state.PID <= 0 {
		t.Fatalf("%s (%v)", out.String(), err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for {
		raw, err := os.ReadFile(argsPath)
		if err == nil && strings.Contains(string(raw), "--hints\nwiki-island,온톨로지\n") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("hints were not forwarded: %q (%v)", raw, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestNexusListenPrepare(t *testing.T) {
	now := time.Now()
	for _, tc := range []struct {
		name, goos, pid, want string
		missing               bool
		markerAge             time.Duration
		marker                bool
		launch                bool
	}{
		{name: "other platform", goos: "linux", want: "unavailable"},
		{name: "missing binary", goos: "darwin", missing: true, want: "unavailable"},
		{name: "fresh marker", goos: "darwin", marker: true, markerAge: 6 * 24 * time.Hour, want: "ready"},
		{name: "expired marker", goos: "darwin", marker: true, markerAge: 7 * 24 * time.Hour, want: "preparing", launch: true},
		{name: "no marker", goos: "darwin", want: "preparing", launch: true},
		{name: "stale pid", goos: "darwin", pid: "99999999", want: "preparing", launch: true},
		{name: "invalid pid", goos: "darwin", pid: "bad", want: "preparing", launch: true},
		{name: "unrelated process", goos: "darwin", pid: strconv.Itoa(os.Getpid()), want: "preparing", launch: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			binary := filepath.Join(dir, "herdr-listen")
			argsPath := filepath.Join(dir, "args")
			if !tc.missing {
				if err := os.WriteFile(binary, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > '"+argsPath+"'\n"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			if tc.marker {
				path := filepath.Join(dir, "listen-assets-ko-KR.ok")
				if err := os.WriteFile(path, nil, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Chtimes(path, now.Add(-tc.markerAge), now.Add(-tc.markerAge)); err != nil {
					t.Fatal(err)
				}
			}
			if tc.pid != "" {
				if err := os.WriteFile(filepath.Join(dir, "listen-prepare.pid"), []byte(tc.pid), 0600); err != nil {
					t.Fatal(err)
				}
			}
			got := nexusListenPrepareWith(context.Background(), tc.goos, binary, dir, func() time.Time { return now })
			if got["state"] != tc.want || len(got) != 1 {
				t.Fatal(got)
			}
			if tc.launch {
				deadline := time.Now().Add(15 * time.Second)
				for {
					raw, err := os.ReadFile(argsPath)
					if err == nil && string(raw) == "--prepare\n--locale\nko-KR\n" {
						break
					}
					if time.Now().After(deadline) {
						t.Fatalf("launch arguments %q: %v", raw, err)
					}
					time.Sleep(20 * time.Millisecond)
				}
				st, err := os.Stat(filepath.Join(dir, "listen-prepare.pid"))
				if err != nil {
					t.Fatal(err)
				}
				if st.Mode().Perm() != 0600 {
					t.Fatal(st.Mode())
				}
			}
		})
	}
}
