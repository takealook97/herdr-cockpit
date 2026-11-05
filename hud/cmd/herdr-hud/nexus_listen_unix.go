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
)

type nexusListenState struct {
	State   string  `json:"state"`
	Level   float64 `json:"level"`
	Partial string  `json:"partial"`
	Final   string  `json:"final"`
	Error   string  `json:"error"`
	PID     int     `json:"pid,omitempty"`
}

func nexusListen(ctx context.Context, sub string) any {
	home, _ := os.UserHomeDir()
	return nexusListenWith(ctx, sub, runtime.GOOS, filepath.Join(home, ".local/bin/herdr-listen"), hudCacheDir())
}
func nexusListenWith(ctx context.Context, sub, goos, binary, dir string) nexusListenState {
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
		cmd := exec.Command(binary, "--state", statePath)
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
		if pid := readPID(); alive(pid) && identity(pid) {
			return nexusListenState{State: "listening", PID: pid}
		}
		return nexusListenState{State: "idle"}
	}
	if err != nil {
		return fail(err)
	}
	var out nexusListenState
	if err = json.Unmarshal(raw, &out); err != nil {
		return fail(err)
	}
	switch out.State {
	case "idle", "listening", "final", "error":
	default:
		return fail(fmt.Errorf("음성 인식 상태가 올바르지 않습니다"))
	}
	pid := out.PID
	if pid == 0 {
		pid = readPID()
	}
	if out.State == "listening" && (!alive(pid) || !identity(pid)) {
		out.State = "error"
		out.Error = "음성 인식 프로세스가 종료되었습니다"
	}
	return out
}
