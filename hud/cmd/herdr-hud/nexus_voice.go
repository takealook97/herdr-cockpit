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
	"regexp"
	"strings"
	"syscall"
	"time"
)

type nexusVoiceReply struct {
	OK        bool   `json:"ok,omitempty"`
	Pending   bool   `json:"pending,omitempty"`
	Recording *bool  `json:"recording,omitempty"`
	Submitted *bool  `json:"submitted,omitempty"`
	Cancelled *bool  `json:"cancelled,omitempty"`
	Mode      string `json:"mode,omitempty"`
	Terminal  string `json:"terminal,omitempty"`
	Action    string `json:"action,omitempty"`
	Error     string `json:"error,omitempty"`
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
			return fail(errors.New("nexus-voice 터미널에 라벨이 없습니다. `hc kill nexus-voice` 후 다시 여세요"))
		}
		tail, err := hc(ctx, "read", address, "--lines", "40")
		if err != nil {
			return fail(err)
		}
		text := strings.ToLower(string(tail))
		if terminal.Labels["nexus.voice.rev"] == rev && !strings.Contains(text, "/restart to apply") && !strings.Contains(text, "start claude again") {
			return nexusVoiceReply{Mode: "claude", Terminal: address}
		}
		if _, err := hc(ctx, "kill", address); err != nil {
			return fail(err)
		}
		_, _ = hc(ctx, "wait", address, "--timeout", "10")
		_, _ = hc(ctx, "rm", address)
	}
	create := func() ([]byte, error) {
		return hc(ctx, "run", "--bg", "--json", "--name", "nexus-voice", "--cwd", dir, "--label", "nexus.voice=1", "--label", "nexus.voice.rev="+rev, "--no-parent", "--no-notify", "--outlive-parent", "--", "env", "-u", "ANTHROPIC_API_KEY", "-u", "ANTHROPIC_AUTH_TOKEN", "-u", "CLAUDE_CODE_USE_BEDROCK", "-u", "CLAUDE_CODE_USE_VERTEX", claude, "--setting-sources", "", "--settings", path, "--strict-mcp-config", "--mcp-config", `{"mcpServers":{}}`, "--model", "haiku")
	}
	raw, err = create()
	if err != nil && address != "" && nexusVoiceNameTaken(string(raw)+" "+err.Error()) {
		if waitErr := nexusVoicePause(ctx, 500*time.Millisecond); waitErr != nil {
			return fail(waitErr)
		}
		raw, err = create()
	}
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
	return nexusVoiceReady(ctx, created.Address, dir, hc)
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

func nexusVoiceNameTaken(text string) bool {
	text = strings.ToLower(text)
	return strings.Contains(text, "name") && (strings.Contains(text, "already") || strings.Contains(text, "taken") || strings.Contains(text, "in use") || strings.Contains(text, "exists"))
}

func nexusVoicePause(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// Only newly created terminals may accept a trust dialog. Read screen content,
// never scrollback, and require both the explicit choice and our private cwd.
func nexusVoiceReady(ctx context.Context, address, dir string, hc nexusHCRunner) nexusVoiceReply {
	ready := nexusVoiceReply{Mode: "claude", Terminal: address}
	pollCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	home, _ := os.UserHomeDir()
	short := dir
	if home != "" && strings.HasPrefix(dir, home+string(filepath.Separator)) {
		short = "~" + strings.TrimPrefix(dir, home)
	}
	for {
		raw, err := hc(pollCtx, "read", address, "--lines", "0")
		if err != nil {
			if ctx.Err() == nil && pollCtx.Err() != nil {
				return ready
			}
			return nexusVoiceReply{Action: "error", Error: nexusError(err).Error}
		}
		text := string(raw)
		choice, input := false, false
		for _, line := range strings.Split(text, "\n") {
			choice = choice || strings.Contains(line, "Yes, I trust this folder")
			trimmed := strings.TrimSpace(line)
			input = input || trimmed == "›" || strings.HasPrefix(trimmed, "› ") || trimmed == "❯" || strings.HasPrefix(trimmed, "❯ ")
		}
		if choice && (strings.Contains(text, dir) || strings.Contains(text, short)) {
			if _, err := hc(pollCtx, "keys", address, "enter"); err != nil {
				return nexusVoiceReply{Action: "error", Error: nexusError(err).Error}
			}
			return ready
		}
		if input {
			return ready
		}
		if err := nexusVoicePause(pollCtx, 200*time.Millisecond); err != nil {
			if ctx.Err() != nil {
				return nexusVoiceReply{Action: "error", Error: nexusError(ctx.Err()).Error}
			}
			return ready
		}
	}
}

var nexusVoiceKeyPattern = regexp.MustCompile(`^[a-z0-9+_-]{1,20}$`)

func nexusVoiceKey(ctx context.Context, key string, hc nexusHCRunner) nexusVoiceReply {
	if !nexusVoiceKeyPattern.MatchString(key) || strings.HasPrefix(key, "-") {
		return nexusVoiceReply{Action: "error", Error: "올바르지 않은 음성 키입니다"}
	}
	unlock, err := nexusVoiceLock(ctx)
	if err != nil {
		return nexusVoiceReply{Action: "error", Error: nexusError(err).Error}
	}
	defer unlock()
	address, err := nexusVoiceOwned(ctx, hc)
	if err == nil {
		_, err = hc(ctx, "keys", address, key)
	}
	if err != nil {
		return nexusVoiceReply{Action: "error", Error: nexusError(err).Error}
	}
	return nexusVoiceReply{OK: true}
}

// Resolve and validate ownership before sending input to the voice terminal.
func nexusVoiceOwned(ctx context.Context, hc nexusHCRunner) (string, error) {
	address, err := nexusVoiceLive(ctx, hc)
	if err == nil && address == "" {
		err = errors.New("실행 중인 음성 터미널이 없습니다")
	}
	if err == nil {
		err = nexusVoiceCheckOwner(ctx, address, hc)
	}
	return address, err
}

func nexusVoiceCheckOwner(ctx context.Context, address string, hc nexusHCRunner) error {
	raw, err := hc(ctx, "get", address, "--json")
	if err != nil {
		return err
	}
	var terminal struct {
		Labels map[string]string `json:"labels"`
	}
	if err := json.Unmarshal(raw, &terminal); err != nil {
		return err
	}
	if terminal.Labels["nexus.voice"] != "1" {
		return errors.New("음성 터미널 소유 라벨을 확인하지 못했습니다")
	}
	return nil
}

// Keep the lock file in place: unlinking it could let another process lock a
// different inode while an action still owns the original lock.
func nexusVoiceLock(ctx context.Context) (func(), error) {
	dir := filepath.Join(hudCacheDir(), "nexus-voice")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "voice.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		if err := waitCtx.Err(); err != nil {
			f.Close()
			return nil, err
		}
		err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); _ = f.Close() }, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			f.Close()
			return nil, err
		}
		if err := nexusVoicePause(waitCtx, 25*time.Millisecond); err != nil {
			f.Close()
			return nil, err
		}
	}
}

type nexusVoiceState struct {
	Recording bool  `json:"recording"`
	Since     int64 `json:"since"`
}

func nexusVoiceStatePath() string { return filepath.Join(hudCacheDir(), "nexus-voice", "state.json") }

func nexusVoiceRecent(age time.Duration) bool {
	raw, err := os.ReadFile(nexusVoiceStatePath())
	var state nexusVoiceState
	if err != nil || json.Unmarshal(raw, &state) != nil || !state.Recording {
		return false
	}
	elapsed := time.Now().UnixMilli() - state.Since
	return elapsed >= 0 && elapsed <= age.Milliseconds()
}

func nexusVoiceRecording(screen string) bool { return strings.Contains(screen, "⏺ REC") }

const nexusVoiceBlocked = "UserPromptSubmit operation blocked by hook"

// A missing prompt is not evidence that the editor is empty.
func nexusVoiceInput(screen string) (string, bool) {
	input, found := "", false
	for _, line := range strings.Split(screen, "\n") {
		line = strings.TrimSpace(line)
		if line == "❯" || strings.HasPrefix(line, "❯ ") {
			input, found = strings.TrimSpace(strings.TrimPrefix(line, "❯")), true
		}
	}
	return input, found
}

// Poll only the live screen, never history containing old recording markers.
func nexusVoiceWaitREC(ctx context.Context, address string, hc nexusHCRunner) (bool, error) {
	pollCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	for {
		raw, err := hc(pollCtx, "read", address, "--lines", "0")
		if err != nil {
			if ctx.Err() == nil && pollCtx.Err() != nil {
				return false, nil
			}
			return false, err
		}
		if nexusVoiceRecording(string(raw)) {
			return true, nil
		}
		if err := nexusVoicePause(pollCtx, 200*time.Millisecond); err != nil {
			return false, ctx.Err()
		}
	}
}

// Closing an idle dialog must not alter its prompt or start a recording.
func nexusVoiceCancel(ctx context.Context, hc nexusHCRunner) nexusVoiceReply {
	cancelled := false
	fail := func(err error) nexusVoiceReply { return nexusVoiceReply{Action: "error", Error: nexusError(err).Error} }
	unlock, err := nexusVoiceLock(ctx)
	if err != nil {
		return fail(err)
	}
	defer unlock()
	address, err := nexusVoiceLive(ctx, hc)
	if err != nil {
		return fail(err)
	}
	if address == "" {
		_ = os.Remove(nexusVoiceStatePath())
		return nexusVoiceReply{OK: true, Cancelled: &cancelled}
	}
	if err := nexusVoiceCheckOwner(ctx, address, hc); err != nil {
		return fail(err)
	}
	defer os.Remove(nexusVoiceStatePath())
	raw, err := hc(ctx, "read", address, "--lines", "0")
	if err != nil {
		return fail(err)
	}
	visible := nexusVoiceRecording(string(raw))
	if visible || nexusVoiceRecent(5*time.Second) {
		if !visible {
			if _, err := nexusVoiceWaitREC(ctx, address, hc); err != nil {
				return fail(err)
			}
		}
		if _, err := hc(ctx, "keys", address, "esc"); err != nil {
			return fail(err)
		}
		if _, err := hc(ctx, "keys", address, "ctrl+e", "ctrl+u"); err != nil {
			return fail(err)
		}
		cancelled = true
	}
	return nexusVoiceReply{OK: true, Cancelled: &cancelled}
}

func nexusVoiceRecord(ctx context.Context, hc nexusHCRunner) nexusVoiceReply {
	fail := func(err error) nexusVoiceReply { return nexusVoiceReply{Action: "error", Error: nexusError(err).Error} }
	unlock, err := nexusVoiceLock(ctx)
	if err != nil {
		return fail(err)
	}
	defer unlock()
	address, err := nexusVoiceOwned(ctx, hc)
	if err != nil {
		return fail(err)
	}
	raw, err := hc(ctx, "read", address, "--lines", "0")
	if err != nil {
		return fail(err)
	}
	screen := string(raw)
	if !nexusVoiceRecording(screen) && !nexusVoiceRecent(3*time.Second) {
		for attempt := 0; ; attempt++ {
			input, found := nexusVoiceInput(screen)
			if found && input == "" {
				break
			}
			if attempt == 3 {
				return fail(errors.New("입력창을 비우지 못했습니다"))
			}
			if _, err := hc(ctx, "keys", address, "ctrl+e", "ctrl+u"); err != nil {
				return fail(err)
			}
			raw, err = hc(ctx, "read", address, "--lines", "0")
			if err != nil {
				return fail(err)
			}
			screen = string(raw)
		}
		if _, err := hc(ctx, "keys", address, "space"); err != nil {
			return fail(err)
		}
		state, _ := json.Marshal(nexusVoiceState{Recording: true, Since: time.Now().UnixMilli()})
		if err := nexusAtomic(nexusVoiceStatePath(), state); err != nil {
			return fail(err)
		}
		recording, err := nexusVoiceWaitREC(ctx, address, hc)
		if err != nil {
			return fail(err)
		}
		return nexusVoiceReply{OK: true, Recording: &recording, Pending: !recording}
	}
	defer os.Remove(nexusVoiceStatePath())
	blocked := strings.Count(screen, nexusVoiceBlocked)
	if _, err := hc(ctx, "keys", address, "space"); err != nil {
		return fail(err)
	}
	recording, submitted := false, false
	reply := func() nexusVoiceReply { return nexusVoiceReply{OK: true, Recording: &recording, Submitted: &submitted} }
	pollCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	stableText := ""
	var stableSince time.Time
	for {
		if err := nexusVoicePause(pollCtx, 200*time.Millisecond); err != nil {
			if ctx.Err() != nil {
				return fail(ctx.Err())
			}
			return reply()
		}
		raw, err := hc(pollCtx, "read", address, "--lines", "0")
		if pollCtx.Err() != nil {
			if ctx.Err() != nil {
				return fail(ctx.Err())
			}
			return reply()
		}
		if err != nil {
			return fail(err)
		}
		screen = string(raw)
		if strings.Count(screen, nexusVoiceBlocked) > blocked {
			submitted = true
			return reply()
		}
		input, found := nexusVoiceInput(screen)
		if nexusVoiceRecording(screen) || !found || input == "" {
			stableText, stableSince = "", time.Time{}
			continue
		}
		if input != stableText {
			stableText, stableSince = input, time.Now()
			continue
		}
		if time.Since(stableSince) < 400*time.Millisecond {
			continue
		}
		if _, err := hc(pollCtx, "keys", address, "enter"); err != nil {
			return fail(err)
		}
		submitted = true
		return reply()
	}
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
