package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type nexusVoiceReply struct {
	OK       bool   `json:"ok,omitempty"`
	Mode     string `json:"mode,omitempty"`
	Terminal string `json:"terminal,omitempty"`
	Action   string `json:"action,omitempty"`
	Error    string `json:"error,omitempty"`
}

func nexusVoiceEnsure(ctx context.Context, cfg nexusConfig, cache string, lookup func(string) string, hc nexusHCRunner) nexusVoiceReply {
	fail := func(err error) nexusVoiceReply { return nexusVoiceReply{Action: "error", Error: nexusError(err).Error} }
	if strings.EqualFold(cfg.VoiceInput, "apple") {
		return nexusVoiceReply{Mode: "apple"}
	}
	claude := lookup("claude")
	if claude == "" {
		return fail(errors.New("claude CLI를 찾을 수 없습니다"))
	}
	claude, err := filepath.EvalSymlinks(claude)
	if err != nil {
		return fail(err)
	}
	info, err := os.Stat(claude)
	if err != nil {
		return fail(err)
	}
	dir := filepath.Join(cache, "nexus-voice")
	home, err := os.UserHomeDir()
	if err != nil {
		return fail(err)
	}
	command := "'" + strings.ReplaceAll(filepath.Join(home, ".local/bin/herdr-hud"), "'", "'\"'\"'") + "' nexus hook-prompt"
	settings := map[string]any{
		"voice":    map[string]any{"enabled": true, "mode": "tap", "autoSubmit": true},
		"language": "ko", "spinnerTipsEnabled": false, "claudeMdExcludes": []string{"**"},
		"hooks": map[string]any{"UserPromptSubmit": []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": command, "timeout": 60, "onFailure": "block"}}}}},
	}
	raw, err := json.Marshal(settings)
	if err != nil {
		return fail(err)
	}
	path := filepath.Join(dir, "settings.json")
	if err = nexusAtomic(path, raw); err != nil {
		return fail(err)
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%s\x00%d", raw, claude, info.ModTime().UnixNano())))
	rev := fmt.Sprintf("%x", sum[:8])
	address, err := nexusVoiceLive(ctx, hc)
	if err != nil {
		return fail(err)
	}
	if address != "" {
		detail, err := hc(ctx, "get", address, "--json")
		if err != nil {
			return fail(err)
		}
		var terminal struct {
			Labels map[string]string `json:"labels"`
		}
		if err := json.Unmarshal(detail, &terminal); err != nil {
			return fail(err)
		}
		if terminal.Labels["nexus.voice"] != "1" {
			return fail(errors.New("음성 터미널 소유 라벨을 확인하지 못했습니다"))
		}
		tail, err := hc(ctx, "read", address, "--lines", "40")
		if err != nil {
			return fail(err)
		}
		text := strings.ToLower(string(tail))
		if terminal.Labels["nexus.voice.rev"] == rev && !strings.Contains(text, "/restart to apply") && !strings.Contains(text, "start claude again") {
			return nexusVoiceReady(ctx, address, hc)
		}
		if _, err := hc(ctx, "kill", address); err != nil {
			return fail(err)
		}
		if _, err := hc(ctx, "wait", address, "--timeout", "10"); err != nil {
			return fail(err)
		}
		if _, err := hc(ctx, "rm", address); err != nil {
			return fail(err)
		}
	}
	raw, err = hc(ctx, "run", "--bg", "--json", "--name", "nexus-voice", "--cwd", dir, "--label", "nexus.voice=1", "--label", "nexus.voice.rev="+rev, "--no-parent", "--no-notify", "--outlive-parent", "--", "env", "-u", "ANTHROPIC_API_KEY", "-u", "ANTHROPIC_AUTH_TOKEN", "-u", "CLAUDE_CODE_USE_BEDROCK", "-u", "CLAUDE_CODE_USE_VERTEX", claude, "--setting-sources", "", "--settings", path, "--strict-mcp-config", "--mcp-config", `{"mcpServers":{}}`, "--model", "haiku")
	if err != nil {
		return fail(err)
	}
	var created struct {
		Address string `json:"address"`
	}
	if err = json.Unmarshal(raw, &created); err != nil {
		return fail(err)
	}
	if created.Address == "" || strings.Contains(created.Address, "/") {
		return fail(errors.New("음성 터미널 주소를 확인하지 못했습니다"))
	}
	return nexusVoiceReady(ctx, created.Address, hc)
}

func nexusVoiceLive(ctx context.Context, hc nexusHCRunner) (string, error) {
	raw, err := hc(ctx, "ls", "--json")
	if err != nil {
		return "", err
	}
	type voiceTerminal struct {
		Address, Name string
		Labels        map[string]string
		ExitCode      *int `json:"exit_code"`
		Exited        bool `json:"exited"`
	}
	var list struct {
		Terminals []voiceTerminal `json:"terminals"`
	}
	if err = json.Unmarshal(raw, &list); err != nil {
		return "", err
	}
	// Current hc ls omits name and labels; resolve the unique name through get,
	// then require its address to be present in the live list.
	var named voiceTerminal
	for _, t := range list.Terminals {
		if t.Name == "nexus-voice" {
			named = t
			break
		}
	}
	if named.Address == "" && len(list.Terminals) > 0 {
		if detail, getErr := hc(ctx, "get", "nexus-voice", "--json"); getErr == nil {
			if err := json.Unmarshal(detail, &named); err != nil {
				return "", err
			}
		}
	}
	for _, t := range list.Terminals {
		if t.Address == named.Address && named.Name == "nexus-voice" && named.Address != "" && !strings.Contains(named.Address, "/") && !named.Exited && named.ExitCode == nil && !t.Exited && t.ExitCode == nil {
			return named.Address, nil
		}
	}
	return "", nil
}

func nexusVoiceReady(ctx context.Context, address string, hc nexusHCRunner) nexusVoiceReply {
	raw, err := hc(ctx, "read", address, "--lines", "40")
	if err == nil {
		text := strings.ToLower(string(raw))
		if strings.Contains(text, "trust this folder") || strings.Contains(text, "quick safety check") {
			_, err = hc(ctx, "keys", address, "enter")
		}
	}
	if err != nil {
		return nexusVoiceReply{Action: "error", Error: nexusError(err).Error}
	}
	return nexusVoiceReply{Mode: "claude", Terminal: address}
}

func nexusVoiceKey(ctx context.Context, key string, hc nexusHCRunner) nexusVoiceReply {
	address, err := nexusVoiceLive(ctx, hc)
	if err == nil && address == "" {
		err = errors.New("실행 중인 음성 터미널이 없습니다")
	}
	if err == nil {
		_, err = hc(ctx, "keys", address, key)
	}
	if err != nil {
		return nexusVoiceReply{Action: "error", Error: nexusError(err).Error}
	}
	return nexusVoiceReply{OK: true}
}

func nexusDefaultDeps() nexusDeps {
	return nexusDeps{hc: nexusHC, panes: hudPanes, now: time.Now, logPath: filepath.Join(hudCacheDir(), "nexus-log.json"), model: func(ctx context.Context, sys, p string, s []byte) ([]byte, error) {
		runner, err := nexusCLIModel("")
		if err != nil {
			return nil, err
		}
		return runner(ctx, sys, p, s)
	}}
}
func nexusSharedPath() string {
	root := os.Getenv("HERDR_APP_HOME")
	if root == "" {
		home, _ := os.UserHomeDir()
		root = filepath.Join(home, ".config/herdr-app")
	}
	return filepath.Join(root, "shared.json")
}

type nexusSharedHead struct {
	Address   string `json:"address"`
	SpaceName string `json:"spaceName"`
	TabName   string `json:"tabName"`
	Status    string `json:"status"`
	Model     string `json:"model"`
	Space     string `json:"space"`
	Tab       string `json:"tab"`
}
type nexusShared struct {
	Heads     []nexusSharedHead `json:"hub.heads"`
	HubOpen   bool              `json:"hub.open"`
	OverlayID string            `json:"nexus.overlayId"`
	Heartbeat int64             `json:"nexus.heartbeat"`
}
type nexusAppRunner func(context.Context, ...string) error

func nexusApp(ctx context.Context, args ...string) error {
	// Match space-tree/hub.js, including argv[0] for the app bundle binary.
	script := `b="$HOME/.local/bin/herdr-app"; if [ -x "$b" ]; then exec "$b" "$@"; fi; for a in /Applications/Herdr.app "$HOME/Applications/Herdr.app"; do [ -x "$a/Contents/MacOS/Herdr" ] && exec -a herdr-app "$a/Contents/MacOS/Herdr" "$@"; done; exit 127`
	cmd := nexusCommand(ctx, "/bin/bash", append([]string{"-c", script, "nexus"}, args...)...)
	raw, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("화면 이동 실패: %s (%v)", nexusBound(string(raw), 200), err)
	}
	return nil
}
func nexusNavigate(ctx context.Context, s nexusShared, target string, app nexusAppRunner, now time.Time) error {
	call := func(command string, args any) error {
		ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		if args == nil {
			return app(ctx, "do", command)
		}
		raw, _ := json.Marshal(args)
		return app(ctx, "do", command, string(raw))
	}
	var failures []error
	attempt := func(command string, args any) {
		if err := call(command, args); err != nil {
			failures = append(failures, err)
		}
	}
	age := now.UnixMilli() - s.Heartbeat
	if s.OverlayID != "" && s.Heartbeat > 0 && age >= 0 && age <= 2500 {
		attempt("overlay.close", map[string]string{"id": s.OverlayID})
	}
	for _, h := range s.Heads {
		if h.Address == target {
			if !s.HubOpen {
				attempt("space.select", map[string]string{"id": h.Space})
				attempt("tab.select", map[string]string{"id": h.Tab})
			}
			attempt("pane.focus", map[string]string{"terminal": target})
			return errors.Join(failures...)
		}
	}
	return errors.New("이동할 Head가 없습니다")
}
func nexusHookReason(r nexusReply) string {
	switch r.Action {
	case "send":
		return "→ " + r.Label + ": " + nexusBound(nexusSubmitText(r.Message), 80)
	case "ask":
		labels := []string{}
		for _, c := range r.Candidates {
			labels = append(labels, c.Label)
		}
		return "? " + nexusSubmitText(r.Question) + " (후보: " + strings.Join(labels, ", ") + ")"
	case "ignore":
		return "· " + nexusIgnoreSummary
	default:
		return "! " + nexusSubmitText(r.Error)
	}
}

type nexusHookOutput struct {
	Decision           string                  `json:"decision"`
	Reason             string                  `json:"reason"`
	HookSpecificOutput nexusHookSpecificOutput `json:"hookSpecificOutput"`
}
type nexusHookSpecificOutput struct {
	HookEventName          string `json:"hookEventName"`
	SuppressOriginalPrompt bool   `json:"suppressOriginalPrompt"`
}

// Always fail closed: even malformed input and recovered panics emit block JSON.
func nexusHookPrompt(ctx context.Context, stdin io.Reader, stdout io.Writer, d nexusDeps, path string, app nexusAppRunner) (code int) {
	return nexusHookPromptRead(ctx, stdin, stdout, d, path, app, os.ReadFile)
}

func nexusHookPromptRead(ctx context.Context, stdin io.Reader, stdout io.Writer, d nexusDeps, path string, app nexusAppRunner, read func(string) ([]byte, error)) (code int) {
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	reason := "! 요청을 처리하지 못했습니다"
	defer func() {
		if v := recover(); v != nil {
			reason = "! 요청을 처리하지 못했습니다: " + fmt.Sprint(v)
		}
		_ = json.NewEncoder(stdout).Encode(nexusHookOutput{
			Decision: "block", Reason: nexusBound(nexusSubmitText(reason), 120),
			HookSpecificOutput: nexusHookSpecificOutput{"UserPromptSubmit", true},
		})
		code = 0
	}()
	var input struct {
		Prompt string `json:"prompt"`
	}
	decoder := json.NewDecoder(io.LimitReader(stdin, 1<<20))
	if err := decoder.Decode(&input); err != nil {
		reason = "! 입력 JSON이 올바르지 않습니다"
		return
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		reason = "! 입력 JSON이 올바르지 않습니다"
		return
	}
	if nexusSanitize(input.Prompt) == "" {
		reason = "! 프롬프트가 비어 있습니다"
		return
	}
	raw, err := read(path)
	if err != nil {
		reason = "! Head 목록을 읽지 못했습니다"
		return
	}
	var shared nexusShared
	if json.Unmarshal(raw, &shared) != nil {
		reason = "! Head 목록이 올바르지 않습니다"
		return
	}
	panes := d.panes(ctx)
	roster := []nexusRosterEntry{}
	for _, h := range shared.Heads {
		entry := nexusRosterEntry{Address: h.Address, Space: h.SpaceName, Tab: h.TabName, Status: h.Status, Model: h.Model}
		for _, t := range panes.Terminals {
			if t.Address == h.Address {
				entry.Cwd = t.Cwd
				break
			}
		}
		roster = append(roster, entry)
	}
	d.panes = func(context.Context) HUDPanes { return panes }
	reply := nexusRoute(ctx, d, input.Prompt, roster)
	reason = nexusHookReason(reply)
	if reply.Sent {
		raw, err := read(path)
		if err != nil {
			reason = "! 전달했지만 화면 상태를 읽지 못했습니다"
			return
		}
		shared = nexusShared{}
		if json.Unmarshal(raw, &shared) != nil {
			reason = "! 전달했지만 화면 상태가 올바르지 않습니다"
			return
		}
		if err := nexusNavigate(ctx, shared, reply.Target, app, d.now()); err != nil {
			reason = "! 전달했지만 " + err.Error()
		}
	}
	return
}
