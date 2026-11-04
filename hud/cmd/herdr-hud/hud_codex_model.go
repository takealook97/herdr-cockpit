package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

const hudCodexTailLimit = 4 * 1024 * 1024

// Resolve only process-bound local sessions. Neither cwd nor account identifies a session.
func hudResolveCodexModels(ctx context.Context, out *HUDPanes) {
	indices := []int{}
	for i, t := range out.Terminals {
		if filepath.Base(t.Program) == "codex" && t.Address != "" && !strings.Contains(t.Address, "/") && t.Labels["hub.observer"] == "" && t.pid > 0 && len(indices) < 12 {
			indices = append(indices, i)
		}
	}
	if len(indices) == 0 || ctx.Err() != nil {
		return
	}
	raw, err := exec.CommandContext(ctx, "ps", "-A", "-o", "pid=,ppid=,comm=").Output()
	if err != nil {
		return
	}
	procs := hudParseProcesses(string(raw))
	// Bound argv lookups to descendants of selected terminals, never read environments.
	relevant := []hudProcess{}
	roots := map[int]bool{}
	for _, i := range indices {
		roots[out.Terminals[i].pid] = true
	}
	byID := map[int]hudProcess{}
	for _, p := range procs {
		byID[p.PID] = p
	}
	for _, p := range procs {
		if filepath.Base(p.Comm) != "node" {
			continue
		}
		pid := p.PID
		for n := 0; pid > 0 && n < 128; n++ {
			if roots[pid] {
				relevant = append(relevant, p)
				break
			}
			parent, ok := byID[pid]
			if !ok || parent.PPID == pid {
				break
			}
			pid = parent.PPID
		}
		if len(relevant) >= 256 {
			break
		}
	}
	args := hudNodeArgs(ctx, relevant)
	selected := map[int]int{}
	ids := []string{}
	seen := map[int]bool{}
	for _, i := range indices {
		pid := hudCodexNativePID(out.Terminals[i].pid, procs, args)
		if pid == 0 {
			continue
		}
		selected[i] = pid
		if !seen[pid] {
			ids = append(ids, strconv.Itoa(pid))
			seen[pid] = true
		}
	}
	if len(ids) == 0 || ctx.Err() != nil {
		return
	}
	raw, err = exec.CommandContext(ctx, "lsof", "-nP", "-a", "-p", strings.Join(ids, ","), "-Fpn").Output()
	if err != nil || ctx.Err() != nil {
		return
	}
	paths := hudCodexRollouts(string(raw))
	for _, i := range indices {
		pid := selected[i]
		if pid == 0 || len(paths[pid]) != 1 || ctx.Err() != nil {
			continue
		}
		model, effort := hudCodexTranscript(ctx, pid, paths[pid][0])
		if ctx.Err() != nil {
			return
		}
		t := &out.Terminals[i]
		if model != "" {
			t.Model = model
		}
		if effort != "" {
			t.Effort = effort
		}
		for r := range out.Runs {
			for w := range out.Runs[r].Workers {
				worker := &out.Runs[r].Workers[w]
				if worker.Terminal == t.Address {
					if model != "" {
						worker.Model = model
					}
					if effort != "" {
						worker.Effort = effort
					}
				}
			}
		}
	}
}

func hudCodexNativePID(root int, procs []hudProcess, args map[int]string) int {
	lookup := func(pid int) string {
		raw := args[pid]
		argv := hudShellSplit(raw)
		for i := 1; i < len(argv); i++ {
			if strings.HasPrefix(argv[i], "-") {
				continue
			}
			if strings.HasSuffix(argv[i], "/@openai/codex/bin/codex.js") {
				return "node codex"
			}
			break
		}
		return raw
	}
	children := map[int][]int{}
	byID := map[int]hudProcess{}
	for _, p := range procs {
		children[p.PPID] = append(children[p.PPID], p.PID)
		byID[p.PID] = p
	}
	level := []int{root}
	seen := map[int]bool{}
	pid := 0
	for len(level) > 0 {
		next := []int{}
		matches := 0
		provider := ""
		for _, id := range level {
			if seen[id] {
				continue
			}
			seen[id] = true
			p := byID[id]
			name := filepath.Base(p.Comm)
			found := ""
			if name == "codex" || name == "claude" {
				found = name
			} else if name == "node" {
				found = hudNodeProvider(lookup(id))
			}
			if found != "" {
				matches++
				pid, provider = id, found
			}
			next = append(next, children[id]...)
		}
		if matches > 0 {
			if matches != 1 || provider != "codex" {
				return 0
			}
			break
		}
		level = next
	}
	if pid == 0 {
		return 0
	}
	for depth := 0; depth < 16; depth++ {
		for _, p := range procs {
			if p.PID == pid && filepath.Base(p.Comm) == "codex" {
				return pid
			}
		}
		// A CLI node wrapper spawns the native executable directly. Never walk past
		// a native agent into its tool shells or nested agent workers.
		next := 0
		for _, p := range procs {
			if p.PPID != pid {
				continue
			}
			name := filepath.Base(p.Comm)
			if name == "codex" || (name == "node" && hudNodeProvider(lookup(p.PID)) == "codex") {
				if next != 0 {
					return 0
				}
				next = p.PID
			}
		}
		if next == 0 {
			return 0
		}
		pid = next
	}
	return 0
}

func hudCodexRollouts(raw string) map[int][]string {
	out := map[int][]string{}
	pid := 0
	for _, line := range strings.Split(raw, "\n") {
		if len(line) == 0 {
			continue
		}
		switch line[0] {
		case 'p':
			pid, _ = strconv.Atoi(line[1:])
		case 'n':
			path := line[1:]
			base := filepath.Base(path)
			if pid <= 0 || !filepath.IsAbs(path) || !strings.HasPrefix(base, "rollout-") || !strings.HasSuffix(base, ".jsonl") {
				continue
			}
			duplicate := false
			for _, old := range out[pid] {
				if old == path {
					duplicate = true
				}
			}
			if !duplicate {
				out[pid] = append(out[pid], path)
			}
		}
	}
	return out
}

var hudCodexCacheMu sync.Mutex

type hudCodexCacheEntry struct {
	PID    int    `json:"pid"`
	Path   string `json:"path"`
	Mtime  int64  `json:"mtime"`
	Size   int64  `json:"size"`
	Device uint64 `json:"device"`
	Inode  uint64 `json:"inode"`
	Model  string `json:"model"`
	Effort string `json:"effort"`
}

func hudCodexCachePath() string { return filepath.Join(hudCacheDir(), "codex-models.json") }

func hudCodexTranscript(ctx context.Context, pid int, path string) (model, effort string) {
	if pid <= 0 || ctx.Err() != nil {
		return
	}
	hudCodexCacheMu.Lock()
	defer hudCodexCacheMu.Unlock()
	if ctx.Err() != nil {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return
	}
	entry := hudCodexCacheEntry{PID: pid, Path: path, Mtime: info.ModTime().UnixNano(), Size: info.Size()}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		entry.Device, entry.Inode = uint64(stat.Dev), uint64(stat.Ino)
	}
	cache := map[string]hudCodexCacheEntry{}
	if cf, err := os.Open(hudCodexCachePath()); err == nil {
		raw, err := io.ReadAll(io.LimitReader(cf, 1024*1024))
		cf.Close()
		if err == nil {
			_ = json.Unmarshal(raw, &cache)
		}
	}
	if cache == nil || len(cache) > 256 {
		cache = map[string]hudCodexCacheEntry{}
	}
	key := fmt.Sprintf("%d:%s", pid, path)
	previous, ok := cache[key]
	same := ok && previous.PID == pid && previous.Path == path && previous.Device == entry.Device && previous.Inode == entry.Inode
	if same && previous.Mtime == entry.Mtime && previous.Size == entry.Size {
		return previous.Model, previous.Effort
	}
	// Retention is safe only for growth of the same file and process association.
	if same && entry.Size > previous.Size {
		model, effort = previous.Model, previous.Effort
	}
	offset := info.Size() - hudCodexTailLimit
	if offset < 0 {
		offset = 0
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return "", ""
	}
	raw, err := io.ReadAll(io.LimitReader(f, hudCodexTailLimit))
	if err != nil || ctx.Err() != nil {
		return "", ""
	}
	freshModel, freshEffort := hudCodexTurnContext(raw, offset > 0)
	if freshModel != "" {
		model = freshModel
	}
	if freshEffort != "" {
		effort = freshEffort
	}
	entry.Model, entry.Effort = model, effort
	// Drop previous associations for a reused PID, including switching back to an old path.
	for k, e := range cache {
		if e.PID == pid && k != key {
			delete(cache, k)
		}
	}
	cache[key] = entry
	if len(cache) > 256 {
		cache = map[string]hudCodexCacheEntry{key: entry}
	}
	hudWriteCodexCache(cache)
	return
}

// Only newline-terminated turn_context metadata is decoded; message contents are ignored.
func hudCodexTurnContext(raw []byte, partialPrefix bool) (string, string) {
	lines := bytes.Split(raw, []byte{'\n'})
	if partialPrefix && len(lines) > 0 {
		lines = lines[1:]
	}
	model, effort := "", ""
	for i := len(lines) - 2; i >= 0 && (model == "" || effort == ""); i-- {
		var record struct {
			Type    string `json:"type"`
			Payload struct {
				Model           string `json:"model"`
				Effort          string `json:"effort"`
				ReasoningEffort string `json:"reasoning_effort"`
			} `json:"payload"`
		}
		if json.Unmarshal(lines[i], &record) != nil || record.Type != "turn_context" {
			continue
		}
		if model == "" {
			model = record.Payload.Model
		}
		if effort == "" {
			effort = record.Payload.Effort
			if effort == "" {
				effort = record.Payload.ReasoningEffort
			}
		}
	}
	return model, effort
}

func hudWriteCodexCache(cache map[string]hudCodexCacheEntry) {
	path := hudCodexCachePath()
	raw, err := json.Marshal(cache)
	if err != nil || os.MkdirAll(filepath.Dir(path), 0700) != nil {
		return
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".codex-models-*")
	if err != nil {
		return
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(raw); err != nil {
		f.Close()
		return
	}
	if f.Close() == nil {
		_ = os.Rename(f.Name(), path)
	}
}
