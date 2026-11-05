package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func nexusFixture(t *testing.T) nexusDeps {
	t.Helper()
	return nexusDeps{model: func(context.Context, string, string, []byte) ([]byte, error) {
		return []byte(`{"action":"send","target":"t1","message":"do it","confidence":0.9}`), nil
	}, hc: func(context.Context, ...string) ([]byte, error) { return nil, nil }, panes: func(context.Context) HUDPanes {
		return HUDPanes{Terminals: []HUDTerminal{{Address: "t1", detailLoaded: true, Program: "claude"}}}
	}, now: func() time.Time { return time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC) }, logPath: filepath.Join(t.TempDir(), "log.json")}
}
func nexusRoster() []nexusRosterEntry {
	return []nexusRosterEntry{{Address: "t1", Space: "space", Tab: "tab"}}
}
func TestNexusRoster(t *testing.T) {
	panes := HUDPanes{Terminals: []HUDTerminal{{Address: "t1", detailLoaded: true, Program: "claude"}, {Address: "t2", detailLoaded: true, Program: "codex"}, {Address: "t3", detailLoaded: true, Program: "claude", Labels: map[string]string{"hub.observer": ""}}, {Address: "remote/t4", detailLoaded: true, Program: "claude"}, {Address: "t6", Program: "zsh"}}, Runs: []HUDRun{{Workers: []HUDWorker{{Terminal: "t2"}}}}}
	for _, tc := range []struct {
		addr string
		want int
	}{{"t1", 1}, {"t2", 0}, {"t3", 0}, {"remote/t4", 0}, {"t5", 0}, {"t6", 0}} {
		t.Run(tc.addr, func(t *testing.T) {
			if got := nexusValidRoster([]nexusRosterEntry{{Address: tc.addr}}, panes); len(got) != tc.want {
				t.Fatalf("%+v", got)
			}
		})
	}
}
func TestNexusRoute(t *testing.T) {
	for _, tc := range []struct {
		name, raw, action string
		err               error
		sent              bool
	}{{"send", `{"action":"send","target":"t1","message":"-do it","confidence":0.9}`, "send", nil, true}, {"low", `{"action":"send","target":"t1","message":"x","confidence":0.4}`, "ask", nil, false}, {"unknown", `{"action":"send","target":"bad","message":"x","confidence":0.9}`, "ask", nil, false}, {"model error", "", "error", errors.New("model failed"), false}, {"invalid", "{", "error", nil, false}, {"timeout", "", "error", context.DeadlineExceeded, false}, {"invalid action", `{"action":"delete"}`, "error", nil, false}} {
		t.Run(tc.name, func(t *testing.T) {
			d := nexusFixture(t)
			d.model = func(context.Context, string, string, []byte) ([]byte, error) { return []byte(tc.raw), tc.err }
			var calls [][]string
			d.hc = func(_ context.Context, args ...string) ([]byte, error) { calls = append(calls, args); return nil, nil }
			r := nexusRoute(context.Background(), d, "command", nexusRoster())
			if r.Action != tc.action || r.Sent != tc.sent {
				t.Fatalf("%+v", r)
			}
			if tc.sent {
				if r.Label != "space · tab" || !reflect.DeepEqual(calls, [][]string{{"send", "--", "t1", "-do it"}}) {
					t.Fatalf("%+v %v", r, calls)
				}
			} else if len(calls) != 0 {
				t.Fatal(calls)
			}
			if tc.name == "low" && r.Message != "x" {
				t.Fatal("ask lost proposed instruction", r)
			}
			if r.Action == "ask" && len(r.Candidates) == 0 {
				t.Fatal("missing candidates")
			}
			if len(nexusLoadLog(d.logPath)) != 1 {
				t.Fatal("missing log")
			}
		})
	}
}
func TestNexusRead(t *testing.T) {
	d := nexusFixture(t)
	calls := 0
	d.model = func(_ context.Context, sys, p string, s []byte) ([]byte, error) {
		calls++
		if calls == 1 {
			return []byte(`{"action":"read","target":"t1","confidence":0.4}`), nil
		}
		if strings.Contains(p, "line-059\n") || !strings.Contains(p, "line-060\n") || !strings.HasSuffix(p, "line-099") {
			t.Fatalf("bad tail: %s", p)
		}
		return []byte(`{"summary":"done"}`), nil
	}
	d.hc = func(_ context.Context, args ...string) ([]byte, error) {
		if !reflect.DeepEqual(args, []string{"read", "t1"}) {
			t.Fatal(args)
		}
		var b strings.Builder
		for i := 0; i < 100; i++ {
			fmt.Fprintf(&b, "line-%03d\n\n", i)
		}
		return []byte(b.String()), nil
	}
	r := nexusRoute(context.Background(), d, "status?", nexusRoster())
	if r.Summary != "done" || r.Action != "read" || r.Sent || calls != 2 {
		t.Fatalf("%+v calls %d", r, calls)
	}
}
func TestNexusSend(t *testing.T) {
	for _, tc := range []struct {
		name, to, text string
		hcErr          error
		action         string
	}{{"valid", "t1", "-hello", nil, "send"}, {"invalid", "t9", "hi", nil, "error"}, {"empty", "t1", "\x00", nil, "error"}, {"hc failure", "t1", "hello", errors.New(strings.Repeat("가", 500)), "error"}} {
		t.Run(tc.name, func(t *testing.T) {
			d := nexusFixture(t)
			count := 0
			d.hc = func(_ context.Context, args ...string) ([]byte, error) { count++; return nil, tc.hcErr }
			r := nexusSend(context.Background(), d, tc.to, tc.text, nexusRoster())
			if r.Action != tc.action || len([]rune(r.Error)) > 300 {
				t.Fatalf("%+v", r)
			}
			if (tc.to == "t9" || tc.name == "empty") && count != 0 {
				t.Fatal(count)
			}
			if len(nexusLoadLog(d.logPath)) != 1 {
				t.Fatal("missing log")
			}
		})
	}
}
func TestNexusEmptyRoster(t *testing.T) {
	d := nexusFixture(t)
	d.model = func(context.Context, string, string, []byte) ([]byte, error) {
		t.Fatal("model called")
		return nil, nil
	}
	r := nexusRoute(context.Background(), d, "hi", nil)
	if r.Action != "error" || r.Error != "Head가 없습니다" {
		t.Fatal(r)
	}
}
func TestNexusSanitize(t *testing.T) {
	for _, tc := range []struct{ in, want string }{{" \x00a\x1b\nb\tc\x7f ", "a\nb\tc"}, {strings.Repeat("가", 5000), strings.Repeat("가", 4000)}} {
		if got := nexusSanitize(tc.in); got != tc.want {
			t.Fatalf("got %q", got)
		}
	}
}
func TestNexusLog(t *testing.T) {
	d := nexusFixture(t)
	for i := 0; i < 60; i++ {
		if err := nexusAppendLog(d.logPath, nexusLogEntry{At: fmt.Sprint(i), Text: fmt.Sprintf("entry-%02d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	log := nexusLoadLog(d.logPath)
	if len(log) != 50 || log[0].Text != "entry-10" || log[49].Text != "entry-59" {
		t.Fatal(log)
	}
	st, _ := os.Stat(d.logPath)
	if st.Mode().Perm() != 0600 {
		t.Fatal(st.Mode())
	}
	d.model = func(_ context.Context, sys, p string, s []byte) ([]byte, error) {
		if strings.Count(p, "entry-") != 6 || strings.Contains(p, "entry-53") {
			t.Fatal(p)
		}
		return []byte(`{"action":"ask","question":"which?"}`), nil
	}
	nexusRoute(context.Background(), d, "hello", nexusRoster())
}
func TestCmdNexus(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	for _, args := range [][]string{nil, {"wat"}, {"route"}, {"send", "--text", "hi", "--roster", "[]"}, {"route", "--text", "hi", "--roster", "{"}, {"route", "--text", "hi", "--roster", "null"}, {"log", "--limit", "-1"}, {"listen"}, {"listen", "wat"}, {"log", "extra"}} {
		var out, stderr bytes.Buffer
		if code := cmdNexus(args, &out, &stderr); code != 2 {
			t.Fatalf("%v: %d %s", args, code, out.String())
		}
	}
	path := filepath.Join(hudCacheDir(), "nexus-log.json")
	for i := 0; i < 5; i++ {
		if err := nexusAppendLog(path, nexusLogEntry{Text: fmt.Sprint(i)}); err != nil {
			t.Fatal(err)
		}
	}
	var out, stderr bytes.Buffer
	if code := cmdNexus([]string{"log", "--limit", "3"}, &out, &stderr); code != 0 {
		t.Fatal(code, stderr.String())
	}
	var reply struct{ Entries []nexusLogEntry }
	if err := json.Unmarshal(out.Bytes(), &reply); err != nil || len(reply.Entries) != 3 || reply.Entries[0].Text != "2" {
		t.Fatal(out.String(), err)
	}
}
func TestNexusClaudeOutput(t *testing.T) {
	for _, tc := range []struct {
		raw, want string
		bad       bool
	}{{`{"structured_output":{"action":"ask"}}`, `{"action":"ask"}`, false}, {`{"result":"{\"action\":\"ask\"}"}`, `{"action":"ask"}`, false}, {`{"is_error":true,"result":"bad"}`, "", true}, {`{`, "", true}, {`{"result":"no json"}`, "", true}} {
		got, err := nexusClaudeOutput([]byte(tc.raw))
		if (err != nil) != tc.bad || string(got) != tc.want {
			t.Fatal(string(got), err)
		}
	}
}

func TestNexusLogFailurePreservesReply(t *testing.T) {
	for _, mode := range []string{"route", "send"} {
		t.Run(mode, func(t *testing.T) {
			d := nexusFixture(t)
			parent := filepath.Join(t.TempDir(), "file")
			if err := os.WriteFile(parent, nil, 0600); err != nil {
				t.Fatal(err)
			}
			d.logPath = filepath.Join(parent, "log.json")
			calls := 0
			d.hc = func(context.Context, ...string) ([]byte, error) { calls++; return nil, nil }
			var r nexusReply
			if mode == "route" {
				r = nexusRoute(context.Background(), d, "hello", nexusRoster())
			} else {
				r = nexusSend(context.Background(), d, "t1", "hello", nexusRoster())
			}
			if r.Action != "send" || !r.Sent || r.Error != "" || !strings.HasPrefix(r.Warning, "기록을 남기지 못했습니다: ") || calls != 1 {
				t.Fatalf("%+v calls=%d", r, calls)
			}
		})
	}
}

func TestNexusIncompleteRoster(t *testing.T) {
	for _, tc := range []struct {
		name       string
		loaded     bool
		panesError string
		want       int
	}{
		{"complete", true, "", 1}, {"unknown labels", false, "", 0}, {"panes error", true, "failed", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			panes := HUDPanes{Error: tc.panesError, Terminals: []HUDTerminal{{Address: "t1", Program: "claude", detailLoaded: tc.loaded}}}
			if got := nexusValidRoster(nexusRoster(), panes); len(got) != tc.want {
				t.Fatal(got)
			}
			if tc.panesError == "" {
				return
			}
			for _, mode := range []string{"route", "send"} {
				d := nexusFixture(t)
				d.panes = func(context.Context) HUDPanes { return panes }
				d.model = func(context.Context, string, string, []byte) ([]byte, error) {
					t.Fatal("model called")
					return nil, nil
				}
				d.hc = func(context.Context, ...string) ([]byte, error) { t.Fatal("hc called"); return nil, nil }
				var r nexusReply
				if mode == "route" {
					r = nexusRoute(context.Background(), d, "hi", nexusRoster())
				} else {
					r = nexusSend(context.Background(), d, "t1", "hi", nexusRoster())
				}
				if r.Error != "Head 목록을 확인하지 못했습니다" {
					t.Fatal(r)
				}
			}
		})
	}
}

func TestNexusSummaryPrefix(t *testing.T) {
	for _, text := range []string{"--help", "-p", "상태 알려줘"} {
		t.Run(text, func(t *testing.T) {
			d := nexusFixture(t)
			calls := 0
			d.model = func(_ context.Context, _, prompt string, _ []byte) ([]byte, error) {
				calls++
				if calls == 1 {
					return []byte(`{"action":"read","target":"t1"}`), nil
				}
				if !strings.HasPrefix(prompt, nexusSummaryPrefix) {
					t.Fatal(prompt)
				}
				return []byte(`{"summary":"완료"}`), nil
			}
			if r := nexusRoute(context.Background(), d, text, nexusRoster()); r.Action != "read" || calls != 2 {
				t.Fatal(r, calls)
			}
		})
	}
}

func TestNexusCommandWaitDelay(t *testing.T) {
	for _, name := range []string{"claude", "codex", "hc"} {
		t.Run(name, func(t *testing.T) {
			if cmd := nexusCommand(context.Background(), name, "--help"); cmd.WaitDelay != 2*time.Second {
				t.Fatal(cmd.WaitDelay)
			}
		})
	}
}

func TestNexusKoreanErrors(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{context.DeadlineExceeded, "모델 호출 시간이 초과됐습니다"},
		{errors.New("failed"), "요청을 처리하지 못했습니다: failed"},
		{errors.New("hc를 찾을 수 없습니다"), "hc를 찾을 수 없습니다"},
	} {
		if got := nexusError(tc.err); got.Error != tc.want {
			t.Fatal(got)
		}
	}
}
