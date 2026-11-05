//go:build darwin || linux

package main

import (
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
	"unicode"
)

type nexusListenState struct {
	EndReason string  `json:"end_reason,omitempty"`
	Engine    string  `json:"engine,omitempty"`
	Laughing  bool    `json:"laughing,omitempty"`
	Trimmed   int     `json:"trimmed,omitempty"`
	State     string  `json:"state"`
	Level     float64 `json:"level"`
	Partial   string  `json:"partial"`
	Final     string  `json:"final"`
	Error     string  `json:"error"`
	PID       int     `json:"pid,omitempty"`
}

func nexusListen(ctx context.Context, sub string, expectedPID ...int) any {
	home, _ := os.UserHomeDir()
	return nexusListenWith(ctx, sub, runtime.GOOS, filepath.Join(home, ".local/bin/herdr-listen"), hudCacheDir(), expectedPID...)
}
func nexusListenStart(ctx context.Context, hints string) any {
	home, _ := os.UserHomeDir()
	return nexusListenWithHints(ctx, "start", runtime.GOOS, filepath.Join(home, ".local/bin/herdr-listen"), hudCacheDir(), hints)
}
func nexusListenWith(ctx context.Context, sub, goos, binary, dir string, expectedPID ...int) nexusListenState {
	return nexusListenWithHints(ctx, sub, goos, binary, dir, "", expectedPID...)
}
func nexusListenWithHints(ctx context.Context, sub, goos, binary, dir, hints string, expectedPID ...int) nexusListenState {
	st, err := os.Stat(binary)
	if goos != "darwin" || err != nil || st.IsDir() || st.Mode()&0111 == 0 {
		return nexusListenState{State: "unavailable"}
	}
	statePath := filepath.Join(dir, "listen.json")
	pidPath := filepath.Join(dir, "listen.pid")
	fail := func(err error) nexusListenState {
		return nexusListenState{State: "error", Error: nexusBound("음성 인식을 처리하지 못했습니다: "+err.Error(), 300)}
	}
	readPID := func() int {
		raw, _ := os.ReadFile(pidPath)
		pid, _ := strconv.Atoi(strings.TrimSpace(string(raw)))
		return pid
	}
	alive := func(pid int) bool { return pid > 0 && syscall.Kill(pid, 0) == nil }
	identity := func(pid int) bool {
		if pid <= 0 {
			return false
		}
		raw, err := exec.CommandContext(ctx, "ps", "-o", "comm=", "-p", strconv.Itoa(pid)).Output()
		return err == nil && filepath.Base(strings.TrimSpace(string(raw))) == "herdr-listen"
	}
	if sub == "start" {
		if pid := readPID(); alive(pid) && identity(pid) {
			return nexusListenState{State: "listening", PID: pid}
		}
		if err = os.MkdirAll(dir, 0700); err != nil {
			return fail(err)
		}
		if err = os.Remove(statePath); err != nil && !os.IsNotExist(err) {
			return fail(err)
		}
		cmd := exec.Command(binary, nexusListenArgs(statePath, nexusLoadConfig(), hints)...)
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if err = cmd.Start(); err != nil {
			return fail(err)
		}
		pid := cmd.Process.Pid
		if err = nexusAtomic(pidPath, []byte(strconv.Itoa(pid))); err != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			return fail(err)
		}
		if err = cmd.Process.Release(); err != nil {
			return fail(err)
		}
		return nexusListenState{State: "listening", PID: pid}
	}
	if sub == "stop" {
		pid := readPID()
		if len(expectedPID) > 0 && (pid <= 0 || pid != expectedPID[0] || (alive(pid) && !identity(pid))) {
			return nexusListenWith(ctx, "status", goos, binary, dir)
		}
		if alive(pid) && identity(pid) {
			if err = syscall.Kill(pid, syscall.SIGTERM); err != nil {
				return fail(err)
			}
		} else {
			raw, readErr := os.ReadFile(statePath)
			var stale nexusListenState
			if readErr == nil && json.Unmarshal(raw, &stale) == nil && stale.State == "listening" {
				if err = os.Remove(statePath); err != nil && !os.IsNotExist(err) {
					return fail(err)
				}
			}
		}
		if err = os.Remove(pidPath); err != nil && !os.IsNotExist(err) {
			return fail(err)
		}
		return nexusListenState{State: "idle"}
	}
	raw, err := os.ReadFile(statePath)
	if os.IsNotExist(err) {
		pid := readPID()
		if alive(pid) && identity(pid) {
			return nexusListenState{State: "listening", PID: pid}
		}
		return nexusListenState{State: "idle", PID: pid}
	}
	if err != nil {
		return fail(err)
	}
	var out nexusListenState
	var extra struct {
		EndReason string `json:"endReason"`
	}
	_ = json.Unmarshal(raw, &extra)
	out.EndReason = extra.EndReason
	if err = json.Unmarshal(raw, &out); err != nil {
		return fail(err)
	}
	switch out.State {
	case "idle", "listening", "final", "error":
	default:
		return fail(fmt.Errorf("음성 인식 상태가 올바르지 않습니다"))
	}
	pid := out.PID
	trackedPID := readPID()
	if pid == 0 || (out.State == "listening" && trackedPID != pid && alive(trackedPID) && identity(trackedPID)) {
		pid = trackedPID
	}
	out.PID = pid
	if out.State == "listening" && (!alive(pid) || !identity(pid)) {
		out.State = "error"
		out.Error = "음성 인식 프로세스가 종료되었습니다"
	}
	return out
}

func nexusListenArgs(statePath string, cfg nexusConfig, hints ...string) []string {
	args := []string{"--state", statePath}
	if cfg.KeepAudio > 0 && cfg.KeepAudio <= 100 {
		args = append(args, "--keep-audio", strconv.Itoa(cfg.KeepAudio))
	}
	if cfg.LaughThreshold >= 0.1 && cfg.LaughThreshold <= 0.99 {
		args = append(args, "--laugh-threshold", strconv.FormatFloat(cfg.LaughThreshold, 'g', -1, 64))
	}
	if cfg.SpeechEngine != "" {
		args = append(args, "--engine", cfg.SpeechEngine)
	}
	if cfg.ServerSpeech {
		args = append(args, "--server")
	}
	if len(hints) > 0 {
		if cleaned := nexusListenHints(hints[0]); cleaned != "" {
			args = append(args, "--hints", cleaned)
		}
	}
	return args
}

func nexusListenHints(value string) string {
	out := []string{}
	seen := map[string]bool{}
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" || len([]rune(part)) > 64 || strings.ContainsFunc(part, unicode.IsControl) || seen[part] {
			continue
		}
		seen[part] = true
		out = append(out, part)
		if len(out) == 100 {
			break
		}
	}
	return strings.Join(out, ",")
}
