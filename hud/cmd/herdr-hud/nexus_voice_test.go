package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
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
				if args[0] == "get" {
					raw, _ := os.ReadFile(filepath.Join(cache, "nexus-voice", "settings.json"))
					info, _ := os.Stat(voiceTestClaude(t))
					sum := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%s\x00%d", raw, voiceTestClaude(t), info.ModTime().UnixNano())))
					return []byte(fmt.Sprintf(`{"labels":{"nexus.voice":"1","nexus.voice.rev":"%x"}}`, sum[:8])), nil
				}
				if args[0] == "read" {
					return []byte("› "), nil
				}
				return []byte(`{"address":"t5x"}`), nil
			}
			r := nexusVoiceEnsure(context.Background(), nexusConfig{}, cache, func(string) string { return voiceTestClaude(t) }, hc)
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
			if json.Unmarshal(raw, &settings) != nil || !settings.Voice.Enabled || !settings.Voice.AutoSubmit || settings.Voice.Mode != "tap" || settings.Language != "ko" {
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
				if len(calls) != 3 {
					t.Fatal(calls)
				}
			} else {
				want := []string{"run", "--bg", "--json", "--name", "nexus-voice", "--cwd", dir, "--label", "nexus.voice=1", "--label", calls[1][10], "--no-parent", "--no-notify", "--outlive-parent", "--", "env", "-u", "ANTHROPIC_API_KEY", "-u", "ANTHROPIC_AUTH_TOKEN", "-u", "CLAUDE_CODE_USE_BEDROCK", "-u", "CLAUDE_CODE_USE_VERTEX", voiceTestClaude(t), "--setting-sources", "", "--settings", path, "--strict-mcp-config", "--mcp-config", `{"mcpServers":{}}`, "--model", "haiku"}
				if len(calls) != 3 || !reflect.DeepEqual(calls[1], want) {
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
			os.WriteFile(shared, []byte(`{"hub.heads":[{"address":"t1","spaceName":"space","tabName":"tab","space":"s1","tab":"tab1"}],"hub.open":true,"nexus.overlayId":"ov1","nexus.heartbeat":1793836800000}`), 0600)
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
				if !reflect.DeepEqual(calls, [][]string{{"do", "overlay.close", `{"id":"ov1"}`}, {"do", "pane.focus", `{"terminal":"t1"}`}}) {
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
			s := nexusShared{Heads: []nexusSharedHead{{Address: "t1", Space: "s1", Tab: "tab1"}}, HubOpen: hub, OverlayID: "ov1"}
			if open {
				s.Heartbeat = 10000
			}
			var calls [][]string
			app := func(_ context.Context, args ...string) error { calls = append(calls, args); return nil }
			if err := nexusNavigate(context.Background(), s, "t1", app, time.UnixMilli(10000)); err != nil {
				t.Fatal(err)
			}
			want := [][]string{}
			if open {
				want = append(want, []string{"do", "overlay.close", `{"id":"ov1"}`})
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
	if err := nexusNavigate(context.Background(), nexusShared{}, "t1", func(context.Context, ...string) error { return errors.New("fixture") }, time.UnixMilli(10000)); err == nil {
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
		case "label", "read":
			return []byte(`{}`), nil
		default:
			t.Fatal(args)
			return nil, nil
		}
	}
	r := nexusVoiceEnsure(context.Background(), nexusConfig{}, t.TempDir(), func(string) string { return voiceTestClaude(t) }, hc)
	if r.Error != "nexus-voice 터미널에 라벨이 없습니다. `hc kill nexus-voice` 후 다시 여세요" || !reflect.DeepEqual(calls, [][]string{{"ls", "--json"}, {"get", "nexus-voice", "--json"}, {"get", "t5x", "--json"}}) {
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
			r := nexusVoiceEnsure(context.Background(), nexusConfig{}, t.TempDir(), func(string) string { return voiceTestClaude(t) }, hc)
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
			return []byte(`{"hub.heads":[{"address":"t1","space":"s1","tab":"tab1"}],"hub.open":true,"nexus.overlayId":"ov1","nexus.heartbeat":1793836800000}`), nil
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

func TestNexusNavigateHeartbeatAndFailures(t *testing.T) {
	for _, age := range []int64{-1, 0, 2500, 2501} {
		for _, hub := range []bool{false, true} {
			s := nexusShared{Heads: []nexusSharedHead{{Address: "t1", Space: "s1", Tab: "tab1"}}, HubOpen: hub, OverlayID: "overlay-id", Heartbeat: 10000 - age}
			var calls []string
			err := nexusNavigate(context.Background(), s, "t1", func(ctx context.Context, args ...string) error {
				deadline, ok := ctx.Deadline()
				if !ok || time.Until(deadline) > 3*time.Second || ctx.Err() != nil {
					t.Fatal("invalid per-call timeout")
				}
				calls = append(calls, args[1])
				return errors.New("fixture failure")
			}, time.UnixMilli(10000))
			want := []string{}
			if age >= 0 && age <= 2500 {
				want = append(want, "overlay.close")
			}
			if !hub {
				want = append(want, "space.select", "tab.select")
			}
			want = append(want, "pane.focus")
			if err == nil || !reflect.DeepEqual(calls, want) {
				t.Fatal(age, hub, calls, err)
			}
		}
	}
}

func TestNexusVoiceKey(t *testing.T) {
	for _, stage := range []string{"ok", "missing", "exited", "remote", "ls", "keys", "get", "unlabeled", "invalid detail"} {
		t.Run(stage, func(t *testing.T) {
			var calls [][]string
			hc := func(_ context.Context, args ...string) ([]byte, error) {
				calls = append(calls, args)
				if args[0] == stage {
					return nil, errors.New("fixture")
				}
				switch args[0] {
				case "ls":
					switch stage {
					case "missing":
						return []byte(`{"terminals":[]}`), nil
					case "exited":
						return []byte(`{"terminals":[{"address":"t1","name":"nexus-voice","exited":true}]}`), nil
					case "remote":
						return []byte(`{"terminals":[{"address":"remote/t1","name":"nexus-voice"}]}`), nil
					}
					return []byte(`{"terminals":[{"address":"t1","name":"nexus-voice"}]}`), nil
				case "get":
					if stage == "unlabeled" {
						return []byte(`{"labels":{}}`), nil
					}
					if stage == "invalid detail" {
						return []byte("{"), nil
					}
					return []byte(`{"labels":{"nexus.voice":"1"}}`), nil
				case "keys":
					return nil, nil
				default:
					t.Fatal("unexpected command", args)
					return nil, nil
				}
			}
			r := nexusVoiceKey(context.Background(), "space", hc)
			if stage == "ok" {
				if !r.OK || !reflect.DeepEqual(calls, [][]string{{"ls", "--json"}, {"get", "t1", "--json"}, {"keys", "t1", "space"}}) {
					t.Fatal(r, calls)
				}
			} else if r.OK || r.Action != "error" || r.Error == "" {
				t.Fatal(r, calls)
			}
		})
	}
}

func TestNexusVoiceEnsureTrust(t *testing.T) {
	for _, scenario := range []string{"third poll", "history only", "reuse", "wrong cwd", "tilde"} {
		t.Run(scenario, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			cache := filepath.Join(home, "cache")
			reads, keys := 0, 0
			hc := func(_ context.Context, args ...string) ([]byte, error) {
				switch args[0] {
				case "ls":
					if scenario == "reuse" {
						return []byte(`{"terminals":[{"address":"t1","name":"nexus-voice"}]}`), nil
					}
					return []byte(`{"terminals":[]}`), nil
				case "run":
					return []byte(`{"address":"t1"}`), nil
				case "get":
					raw, _ := os.ReadFile(filepath.Join(cache, "nexus-voice", "settings.json"))
					info, _ := os.Stat(voiceTestClaude(t))
					sum := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%s\x00%d", raw, voiceTestClaude(t), info.ModTime().UnixNano())))
					return []byte(fmt.Sprintf(`{"labels":{"nexus.voice":"1","nexus.voice.rev":"%x"}}`, sum[:8])), nil
				case "read":
					reads++
					prompt := filepath.Join(cache, "nexus-voice") + "\n1. Yes, I trust this folder"
					if scenario == "reuse" {
						return []byte(prompt), nil
					}
					if !reflect.DeepEqual(args, []string{"read", "t1", "--lines", "0"}) {
						t.Fatal(args)
					}
					if scenario == "third poll" && reads < 3 {
						return nil, nil
					}
					if scenario == "history only" {
						// The accepted dialog exists only in history; screen-only reads omit it.
						return []byte("› "), nil
					}
					if scenario == "wrong cwd" {
						return []byte("/other\nYes, I trust this folder\n› "), nil
					}
					if scenario == "tilde" {
						prompt = "~/cache/nexus-voice\nYes, I trust this folder"
					}
					return []byte(prompt), nil
				case "keys":
					keys++
					if !reflect.DeepEqual(args, []string{"keys", "t1", "enter"}) {
						t.Fatal(args)
					}
					return nil, nil
				default:
					t.Fatal(args)
					return nil, nil
				}
			}
			r := nexusVoiceEnsure(context.Background(), nexusConfig{}, cache, func(string) string { return voiceTestClaude(t) }, hc)
			want := 0
			if scenario == "third poll" || scenario == "tilde" {
				want = 1
			}
			if r.Error != "" || keys != want || (scenario == "third poll" && reads != 3) || (scenario == "reuse" && reads != 1) {
				t.Fatal(r, reads, keys)
			}
		})
	}
}

func TestNexusVoiceKeyValidation(t *testing.T) {
	for _, key := range []string{"", "-enter", "--help", "SPACE", "a b", "a;id", strings.Repeat("a", 21)} {
		r := nexusVoiceKey(context.Background(), key, func(context.Context, ...string) ([]byte, error) { t.Fatal("invalid key reached hc"); return nil, nil })
		if r.Action != "error" {
			t.Fatal(key, r)
		}
	}
}

func voiceTestClaude(t *testing.T) string {
	t.Helper()
	p, err := filepath.EvalSymlinks("/bin/sh")
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestNexusVoiceRevisionLifecycle(t *testing.T) {
	for _, scenario := range []string{"same", "different", "restart", "start again", "missing"} {
		t.Run(scenario, func(t *testing.T) {
			cache := t.TempDir()
			var rev string
			live := false
			var calls []string
			hc := func(_ context.Context, args ...string) ([]byte, error) {
				calls = append(calls, args[0])
				switch args[0] {
				case "ls":
					if live {
						return []byte(`{"terminals":[{"address":"t1","name":"nexus-voice"}]}`), nil
					}
					return []byte(`{"terminals":[]}`), nil
				case "run":
					for i, a := range args {
						if a == "--label" && strings.HasPrefix(args[i+1], "nexus.voice.rev=") {
							rev = strings.TrimPrefix(args[i+1], "nexus.voice.rev=")
						}
					}
					return []byte(`{"address":"t1"}`), nil
				case "get":
					label := "1"
					if scenario == "missing" {
						label = ""
					}
					r := rev
					if scenario == "different" {
						r = "old"
					}
					return json.Marshal(map[string]any{"labels": map[string]string{"nexus.voice": label, "nexus.voice.rev": r}})
				case "read":
					if live && args[3] == "40" && scenario == "restart" {
						return []byte("Update installed · /restart to apply"), nil
					}
					if live && args[3] == "40" && scenario == "start again" {
						return []byte("Please start Claude again"), nil
					}
				}
				return []byte("› "), nil
			}
			lookup := func(string) string { return voiceTestClaude(t) }
			if r := nexusVoiceEnsure(context.Background(), nexusConfig{}, cache, lookup, hc); r.Error != "" {
				t.Fatal(r)
			}
			if len(rev) != 16 {
				t.Fatal(rev)
			}
			live = true
			calls = nil
			r := nexusVoiceEnsure(context.Background(), nexusConfig{}, cache, lookup, hc)
			if scenario == "missing" {
				if r.Error == "" {
					t.Fatal(r)
				}
			} else if r.Error != "" {
				t.Fatal(r)
			}
			got := strings.Join(calls, ",")
			switch scenario {
			case "same":
				if got != "ls,get,read" {
					t.Fatal(got)
				}
			case "missing":
				if got != "ls,get" {
					t.Fatal(got)
				}
			default:
				if got != "ls,get,read,kill,wait,rm,run,read" {
					t.Fatal(got)
				}
			}
		})
	}
}

func TestNexusVoiceRestartCleanupAndRetry(t *testing.T) {
	for _, conflict := range []bool{false, true} {
		t.Run(fmt.Sprint(conflict), func(t *testing.T) {
			var calls []string
			runs := 0
			var firstRun time.Time
			hc := func(_ context.Context, args ...string) ([]byte, error) {
				calls = append(calls, args[0])
				switch args[0] {
				case "ls":
					return []byte(`{"terminals":[{"address":"t1","name":"nexus-voice"}]}`), nil
				case "get":
					return []byte(`{"labels":{"nexus.voice":"1","nexus.voice.rev":"old"}}`), nil
				case "read":
					return []byte("› "), nil
				case "wait", "rm":
					return nil, errors.New("cleanup failed")
				case "run":
					runs++
					if conflict && runs == 1 {
						firstRun = time.Now()
						return nil, errors.New("name nexus-voice already taken")
					}
					if conflict && time.Since(firstRun) < 500*time.Millisecond {
						t.Fatal("retry did not wait")
					}
					return []byte(`{"address":"t2"}`), nil
				}
				return nil, nil
			}
			r := nexusVoiceEnsure(context.Background(), nexusConfig{}, t.TempDir(), func(string) string { return voiceTestClaude(t) }, hc)
			want := "ls,get,read,kill,wait,rm,run,read"
			if conflict {
				want = "ls,get,read,kill,wait,rm,run,run,read"
			}
			if r.Error != "" || r.Terminal != "t2" || strings.Join(calls, ",") != want {
				t.Fatal(r, calls)
			}
		})
	}
}

func TestNexusVoiceRecord(t *testing.T) {
	for _, scenario := range []string{"leftover", "recording", "missing", "unlabelled", "read failure", "clear failure", "space failure"} {
		t.Run(scenario, func(t *testing.T) {
			var calls [][]string
			reads := 0
			hc := func(_ context.Context, args ...string) ([]byte, error) {
				calls = append(calls, append([]string(nil), args...))
				switch args[0] {
				case "ls":
					if scenario == "missing" {
						return []byte(`{"terminals":[]}`), nil
					}
					return []byte(`{"terminals":[{"address":"t1","name":"nexus-voice"}]}`), nil
				case "get":
					if scenario == "unlabelled" {
						return []byte(`{"labels":{}}`), nil
					}
					return []byte(`{"labels":{"nexus.voice":"1"}}`), nil
				case "read":
					if scenario == "read failure" {
						return nil, errors.New("read failed")
					}
					if scenario == "recording" {
						reads++
						if reads > 1 {
							return []byte("❯ "), nil
						}
						return []byte("● REC 00:03\n❯ "), nil
					}
					return []byte("❯ 네. 아 이거 근데"), nil
				case "keys":
					if scenario == "clear failure" && args[2] == "ctrl+e" || scenario == "space failure" && args[2] == "space" {
						return nil, errors.New("keys failed")
					}
					return nil, nil
				default:
					t.Fatalf("unexpected hc call: %v", args)
					return nil, nil
				}
			}
			r := nexusVoiceRecord(context.Background(), hc)
			want := [][]string{{"ls", "--json"}}
			if scenario != "missing" {
				want = append(want, []string{"get", "t1", "--json"})
				if scenario != "unlabelled" {
					want = append(want, []string{"read", "t1", "--lines", "0"})
					if scenario != "read failure" {
						if scenario != "recording" {
							want = append(want, []string{"keys", "t1", "ctrl+e", "ctrl+u"})
						}
						if scenario != "clear failure" {
							want = append(want, []string{"keys", "t1", "space"})
						}
					}
				}
			}
			if scenario == "recording" {
				want = append(want, []string{"read", "t1", "--lines", "0"})
			}
			if !reflect.DeepEqual(calls, want) {
				t.Fatalf("calls %v, want %v", calls, want)
			}
			if scenario == "leftover" || scenario == "recording" {
				raw, err := json.Marshal(r)
				wantJSON := `{"ok":true,"recording":true}`
				if scenario == "recording" {
					wantJSON = `{"ok":true,"recording":false,"submitted":true}`
				}
				if err != nil || string(raw) != wantJSON {
					t.Fatal(string(raw), err)
				}
			} else if r.OK || r.Error == "" || r.Action != "error" || r.Recording != nil {
				t.Fatal(r)
			}
		})
	}
}

func TestNexusVoiceRecordStopSubmission(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		screen string
		enter  int
		sent   bool
	}{
		{"auto submitted hook", "UserPromptSubmit hook\n❯ short phrase", 0, true},
		{"auto submitted empty", "❯ ", 0, true},
		{"short phrase", "❯ 짧은 말", 1, true},
		{"timeout", "● REC 00:04\n❯ pending", 0, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			reads, enters, spaces := 0, 0, 0
			hc := func(_ context.Context, args ...string) ([]byte, error) {
				switch args[0] {
				case "ls":
					return []byte(`{"terminals":[{"address":"t1","name":"nexus-voice"}]}`), nil
				case "get":
					return []byte(`{"labels":{"nexus.voice":"1"}}`), nil
				case "read":
					if !reflect.DeepEqual(args, []string{"read", "t1", "--lines", "0"}) {
						t.Fatalf("unexpected read: %v", args)
					}
					reads++
					if reads <= 2 {
						return []byte("● REC 00:03\n❯ pending"), nil
					}
					return []byte(scenario.screen), nil
				case "keys":
					switch args[2] {
					case "space":
						spaces++
					case "enter":
						enters++
					default:
						t.Fatalf("unexpected keys: %v", args)
					}
				default:
					t.Fatalf("unexpected hc: %v", args)
				}
				return nil, nil
			}
			started := time.Now()
			r := nexusVoiceRecord(context.Background(), hc)
			if !r.OK || r.Recording == nil || *r.Recording || r.Submitted == nil || *r.Submitted != scenario.sent || enters != scenario.enter || spaces != 1 || reads < 3 {
				t.Fatalf("reply %+v, reads %d, enters %d, spaces %d", r, reads, enters, spaces)
			}
			if scenario.name == "timeout" && time.Since(started) < 4*time.Second {
				t.Fatal("returned before polling timeout")
			}
		})
	}
}
