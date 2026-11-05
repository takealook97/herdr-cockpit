package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestNexusVoiceEnsure(t *testing.T) {
	for _, reuse := range []bool{false, true} {
		t.Run(map[bool]string{false: "create", true: "reuse"}[reuse], func(t *testing.T) {
			home := filepath.Join(t.TempDir(), "space $HOME 'quote")
			t.Setenv("HOME", home)
			cache := t.TempDir()
			var calls [][]string
			hc := func(_ context.Context, args ...string) ([]byte, error) {
				calls = append(calls, append([]string(nil), args...))
				if args[0] == "ls" {
					if reuse {
						return []byte(`{"terminals":[{"address":"t5x","name":"nexus-voice","labels":{"nexus.voice":"1"}}]}`), nil
					}
					return []byte(`{"terminals":[]}`), nil
				}
				return []byte(`{"address":"t5x"}`), nil
			}
			r := nexusVoiceEnsure(context.Background(), nexusConfig{}, cache, func(string) string { return "/fake/claude" }, hc)
			if r.Mode != "claude" || r.Terminal != "t5x" || r.Error != "" {
				t.Fatal(r)
			}
			dir := filepath.Join(cache, "nexus-voice")
			path := filepath.Join(dir, "settings.json")
			for p, mode := range map[string]os.FileMode{dir: 0700, path: 0600} {
				st, err := os.Stat(p)
				if err != nil || st.Mode().Perm() != mode {
					t.Fatal(p, st, err)
				}
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var settings struct {
				Voice struct {
					Enabled, AutoSubmit bool
					Mode                string
				}
				Language string
				Hooks    map[string][]struct {
					Hooks []struct {
						Command, Type, OnFailure string
						Timeout                  int
					}
				}
			}
			if json.Unmarshal(raw, &settings) != nil || !settings.Voice.Enabled || !settings.Voice.AutoSubmit || settings.Voice.Mode != "hold" || settings.Language != "ko" {
				t.Fatal(string(raw))
			}
			hook := settings.Hooks["UserPromptSubmit"][0].Hooks[0]
			if hook.Command != "'"+strings.ReplaceAll(filepath.Join(home, ".local/bin/herdr-hud"), "'", "'\"'\"'")+"' nexus hook-prompt" || hook.Type != "command" || hook.OnFailure != "block" || hook.Timeout != 60 {
				t.Fatal(hook)
			}
			binary := filepath.Join(home, ".local/bin/herdr-hud")
			if err := os.MkdirAll(filepath.Dir(binary), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(binary, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\"\n"), 0700); err != nil {
				t.Fatal(err)
			}
			got, err := exec.Command("/bin/sh", "-c", hook.Command).CombinedOutput()
			if err != nil || string(got) != "nexus\nhook-prompt\n" {
				t.Fatalf("hook shell command: %q, %v", got, err)
			}
			if reuse {
				if len(calls) != 1 {
					t.Fatal(calls)
				}
			} else {
				want := []string{"run", "--bg", "--json", "--name", "nexus-voice", "--cwd", dir, "--label", "nexus.voice=1", "--no-parent", "--no-notify", "--outlive-parent", "--", "env", "-u", "ANTHROPIC_API_KEY", "-u", "ANTHROPIC_AUTH_TOKEN", "-u", "CLAUDE_CODE_USE_BEDROCK", "-u", "CLAUDE_CODE_USE_VERTEX", "/fake/claude", "--setting-sources", "", "--settings", path, "--strict-mcp-config", "--mcp-config", `{"mcpServers":{}}`, "--model", "haiku"}
				if len(calls) != 2 || !reflect.DeepEqual(calls[1], want) {
					t.Fatal(calls)
				}
			}
		})
	}
}
func TestNexusVoiceAppleAndMissing(t *testing.T) {
	lookup := func(string) string { return "" }
	hc := func(context.Context, ...string) ([]byte, error) { t.Fatal("unexpected hc"); return nil, nil }
	if r := nexusVoiceEnsure(context.Background(), nexusConfig{VoiceInput: "APPLE"}, "", lookup, hc); r.Mode != "apple" {
		t.Fatal(r)
	}
	if r := nexusVoiceEnsure(context.Background(), nexusConfig{}, "", lookup, hc); r.Error != "claude CLI를 찾을 수 없습니다" {
		t.Fatal(r)
	}
	if c := nexusParseConfig([]byte(`{"VOICEINPUT":"apple"}`)); c.VoiceInput != "apple" {
		t.Fatal(c)
	}
}
func TestNexusDryRunAndVoiceExclusion(t *testing.T) {
	d := nexusFixture(t)
	d.dryRun = true
	d.hc = func(context.Context, ...string) ([]byte, error) { t.Fatal("dry-run sent"); return nil, nil }
	r := nexusRoute(context.Background(), d, "do it", nexusRoster())
	if r.Action != "send" || r.Sent {
		t.Fatal(r)
	}
	if _, err := os.Stat(d.logPath); !os.IsNotExist(err) {
		t.Fatal("dry-run wrote log", err)
	}
	panes := d.panes(context.Background())
	panes.Terminals[0].Labels = map[string]string{"nexus.voice": ""}
	if got := nexusValidRoster(nexusRoster(), panes); len(got) != 0 {
		t.Fatal(got)
	}
}
func TestNexusHookPrompt(t *testing.T) {
	for _, tc := range []struct {
		name, model, input, prefix string
		panics                     bool
	}{
		{"send", `{"action":"send","target":"t1","message":"고쳐 줘","confidence":0.9}`, `{"prompt":"고쳐 줘"}`, "→ space · tab: 고쳐 줘", false},
		{"ask", `{"action":"ask","question":"어디?","candidates":["t1"]}`, `{"prompt":"고쳐 줘"}`, "? 어디? (후보: space · tab)", false},
		{"ignore", `{"action":"ignore"}`, `{"prompt":"잠깐만"}`, "· " + nexusIgnoreSummary, false},
		{"error", `{`, `{"prompt":"고쳐 줘"}`, "! 모델 응답이 올바르지 않습니다", false},
		{"invalid stdin", "", `{`, "! 입력 JSON이 올바르지 않습니다", false},
		{"panic", "", `{"prompt":"고쳐 줘"}`, "! 요청을 처리하지 못했습니다: fixture panic", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := nexusFixture(t)
			d.model = func(context.Context, string, string, []byte) ([]byte, error) {
				if tc.panics {
					panic("fixture panic")
				}
				return []byte(tc.model), nil
			}
			shared := filepath.Join(t.TempDir(), "shared.json")
			os.WriteFile(shared, []byte(`{"hub.heads":[{"address":"t1","spaceName":"space","tabName":"tab","space":"s1","tab":"tab1"}],"hub.open":true,"nexus.open":true}`), 0600)
			var calls [][]string
			app := func(_ context.Context, args ...string) error { calls = append(calls, args); return nil }
			var out bytes.Buffer
			if code := nexusHookPrompt(context.Background(), strings.NewReader(tc.input), &out, d, shared, app); code != 0 {
				t.Fatal(code)
			}
			var block struct {
				Decision, Reason   string
				HookSpecificOutput struct {
					HookEventName          string
					SuppressOriginalPrompt bool
				}
			}
			if err := json.Unmarshal(out.Bytes(), &block); err != nil {
				t.Fatal(err, out.String())
			}
			if block.Decision != "block" || block.Reason != tc.prefix || block.HookSpecificOutput.HookEventName != "UserPromptSubmit" || !block.HookSpecificOutput.SuppressOriginalPrompt {
				t.Fatal(out.String())
			}
			if tc.name == "send" {
				if !reflect.DeepEqual(calls, [][]string{{"do", "space-tree.nexus"}, {"do", "pane.focus", `{"terminal":"t1"}`}}) {
					t.Fatal(calls)
				}
			} else if len(calls) != 0 {
				t.Fatal(calls)
			}
		})
	}
}
func TestNexusNavigate(t *testing.T) {
	for _, hub := range []bool{true, false} {
		for _, open := range []bool{true, false} {
			s := nexusShared{Heads: []nexusSharedHead{{Address: "t1", Space: "s1", Tab: "tab1"}}, HubOpen: hub, NexusOpen: open}
			var calls [][]string
			app := func(_ context.Context, args ...string) error { calls = append(calls, args); return nil }
			if err := nexusNavigate(context.Background(), s, "t1", app); err != nil {
				t.Fatal(err)
			}
			want := [][]string{}
			if open {
				want = append(want, []string{"do", "space-tree.nexus"})
			}
			if !hub {
				want = append(want, []string{"do", "space.select", `{"id":"s1"}`}, []string{"do", "tab.select", `{"id":"tab1"}`})
			}
			want = append(want, []string{"do", "pane.focus", `{"terminal":"t1"}`})
			if !reflect.DeepEqual(calls, want) {
				t.Fatal(calls, want)
			}
		}
	}
	if err := nexusNavigate(context.Background(), nexusShared{NexusOpen: true}, "t1", func(context.Context, ...string) error { return errors.New("fixture") }); err == nil {
		t.Fatal("missing navigation error")
	}
}
func TestNexusHookBound(t *testing.T) {
	if got := nexusHookReason(nexusReply{Action: "send", Label: "s · t", Message: strings.Repeat("한", 100)}); len([]rune(got)) != len([]rune("→ s · t: "))+80 {
		t.Fatal(got)
	}
}

func TestNexusVoiceResolveName(t *testing.T) {
	var calls [][]string
	hc := func(_ context.Context, args ...string) ([]byte, error) {
		calls = append(calls, args)
		switch args[0] {
		case "ls":
			return []byte(`{"terminals":[{"address":"t5x","state":"running"}]}`), nil
		case "get":
			return []byte(`{"address":"t5x","name":"nexus-voice","exit_code":null,"labels":{}}`), nil
		case "label":
			return []byte(`{}`), nil
		default:
			t.Fatal(args)
			return nil, nil
		}
	}
	r := nexusVoiceEnsure(context.Background(), nexusConfig{}, t.TempDir(), func(string) string { return "/fake/claude" }, hc)
	if r.Terminal != "t5x" || !reflect.DeepEqual(calls, [][]string{{"ls", "--json"}, {"get", "nexus-voice", "--json"}, {"label", "t5x", "nexus.voice=1"}}) {
		t.Fatal(r, calls)
	}
}

func TestNexusHaikuCLI(t *testing.T) {
	home := t.TempDir()
	bin := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", bin)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("HERDR_NEXUS_MODEL", "")
	capture := filepath.Join(t.TempDir(), "args")
	t.Setenv("NEXUS_TEST_ARGS", capture)
	// A fixture executable only: never start a real model CLI from unit tests.
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$NEXUS_TEST_ARGS\"\nprintf '%s\\n' '{\"structured_output\":{\"action\":\"ignore\"}}'\n"
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"", "haiku", "claude-haiku"} {
		runner, err := nexusCLIModel(key)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = runner(context.Background(), "sys", "prompt", []byte(`{}`)); err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(capture)
		if err != nil {
			t.Fatal(err)
		}
		want := "--model\nhaiku\n"
		if key == "" {
			want = "--model\nsonnet\n"
		}
		if !strings.Contains(string(raw), want) || (key != "" && strings.Contains(string(raw), "--effort")) {
			t.Fatal(string(raw))
		}
	}
}

func TestNexusHookRosterAndNavigationFailure(t *testing.T) {
	d := nexusFixture(t)
	d.panes = func(context.Context) HUDPanes {
		return HUDPanes{Terminals: []HUDTerminal{{Address: "t1", Program: "claude", Cwd: "/project", detailLoaded: true}, {Address: "voice", Program: "claude", Labels: map[string]string{"nexus.voice": "1"}, detailLoaded: true}}}
	}
	d.model = func(_ context.Context, _ string, p string, _ []byte) ([]byte, error) {
		if !strings.Contains(p, "/project") || strings.Contains(p, "voice |") {
			t.Fatal(p)
		}
		return []byte(`{"action":"send","target":"t1","message":"고쳐 줘","confidence":0.9}`), nil
	}
	path := filepath.Join(t.TempDir(), "shared.json")
	os.WriteFile(path, []byte(`{"hub.heads":[{"address":"t1","spaceName":"space","tabName":"tab"},{"address":"voice","spaceName":"voice"}],"hub.open":true}`), 0600)
	var out bytes.Buffer
	nexusHookPrompt(context.Background(), strings.NewReader(`{"prompt":"고쳐 줘"}`), &out, d, path, func(context.Context, ...string) error { return errors.New(strings.Repeat("실패", 100)) })
	var block nexusHookOutput
	if json.Unmarshal(out.Bytes(), &block) != nil || block.Decision != "block" || !strings.HasPrefix(block.Reason, "! 전달했지만 ") || len([]rune(block.Reason)) > 120 {
		t.Fatal(out.String())
	}
}

func TestNexusVoiceEnsureErrors(t *testing.T) {
	for _, stage := range []string{"ls", "invalid list", "run", "invalid created", "empty created"} {
		t.Run(stage, func(t *testing.T) {
			hc := func(_ context.Context, args ...string) ([]byte, error) {
				if args[0] == "ls" {
					switch stage {
					case "ls":
						return nil, errors.New("목록 실패")
					case "invalid list":
						return []byte(`{`), nil
					}
					return []byte(`{"terminals":[]}`), nil
				}
				switch stage {
				case "run":
					return nil, errors.New("실행 실패")
				case "invalid created":
					return []byte(`{`), nil
				}
				return []byte(`{}`), nil
			}
			r := nexusVoiceEnsure(context.Background(), nexusConfig{}, t.TempDir(), func(string) string { return "/fake/claude" }, hc)
			if r.Action != "error" || r.Error == "" || r.Terminal != "" {
				t.Fatal(r)
			}
		})
	}
}

func TestNexusHookRefreshesNavigationState(t *testing.T) {
	d := nexusFixture(t)
	routed := false
	d.model = func(ctx context.Context, _, _ string, _ []byte) ([]byte, error) {
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 40*time.Second {
			t.Fatal("missing hook deadline")
		}
		routed = true
		return []byte(`{"action":"send","target":"t1","message":"go","confidence":0.9}`), nil
	}
	reads := 0
	read := func(string) ([]byte, error) {
		reads++
		if reads == 1 {
			return []byte(`{"hub.heads":[{"address":"t1","space":"s1","tab":"tab1"}],"hub.open":true,"nexus.open":true}`), nil
		}
		if !routed {
			t.Fatal("state refreshed before routing")
		}
		// Absent open keys also mean closed, not the previous snapshot's true.
		return []byte(`{"hub.heads":[{"address":"t1","space":"s1","tab":"tab1"}]}`), nil
	}
	var calls [][]string
	app := func(ctx context.Context, args ...string) error {
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 3*time.Second {
			t.Fatal("missing navigation deadline")
		}
		calls = append(calls, args)
		return nil
	}
	var out bytes.Buffer
	nexusHookPromptRead(context.Background(), strings.NewReader(`{"prompt":"go"}`), &out, d, "shared.json", app, read)
	want := [][]string{{"do", "space.select", `{"id":"s1"}`}, {"do", "tab.select", `{"id":"tab1"}`}, {"do", "pane.focus", `{"terminal":"t1"}`}}
	if reads != 2 || !reflect.DeepEqual(calls, want) {
		t.Fatal(reads, calls, out.String())
	}
}
