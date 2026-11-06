package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const nexusContextHeads = 8
const nexusContextBudget = time.Second

func nexusContextCwd(path string) string {
	if path == "" {
		return ""
	}
	path = filepath.Clean(path)
	parent := filepath.Dir(path)
	if parent == "." || parent == string(filepath.Separator) {
		return path
	}
	return filepath.Join(filepath.Base(parent), filepath.Base(path))
}

func nexusRecent(screen, report string) string {
	lines := strings.Split(nexusSanitizeScreen(screen), "\n")
	content := make([]string, 0, 3)
	for i := len(lines) - 1; i >= 0 && len(content) < 3; i-- {
		line := strings.TrimSpace(strings.Map(func(r rune) rune {
			if r >= 0x2500 && r <= 0x259f {
				return -1
			}
			return r
		}, lines[i]))
		if line == "" || line == report || nexusChromeLine(line) {
			continue
		}
		content = append(content, line)
	}
	for i, j := 0, len(content)-1; i < j; i, j = i+1, j-1 {
		content[i], content[j] = content[j], content[i]
	}
	return nexusBound(strings.Join(content, " / "), 160)
}

func nexusChromeLine(line string) bool {
	if strings.ContainsAny(string([]rune(line)[0]), "❯⏵✻✶✳⎿") {
		return true
	}
	if strings.HasPrefix(line, "Tip:") {
		return true
	}
	lower := strings.ToLower(line)
	for _, phrase := range []string{"bypass permissions", "shift+tab", "esc to interrupt", "auto mode", "shells still running", "for agents", "tokens", "baked for", "churned for", "cooked for", "⎿  tip:", "ctrl+b to run in background", "running…", "thinking…"} {
		if strings.Contains(lower, phrase) {
			return true
		}
	}
	if strings.HasPrefix(line, "⏺") {
		status := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(line, "⏺")))
		for _, word := range []string{"working", "thinking", "running", "loading", "waiting", "processing", "done", "completed", "idle"} {
			if status == word || strings.HasPrefix(status, word+" ") || strings.HasPrefix(status, word+"…") || strings.HasPrefix(status, word+"...") {
				return true
			}
		}
	}
	return false
}

func nexusContextReport(report string) string {
	report = nexusBound(nexusSanitize(report), 160)
	switch strings.ToLower(strings.TrimSpace(report)) {
	case "claude code", "codex", "claude":
		return ""
	}
	return report
}

// Sanitize each line without the command's 4000-rune prefix bound: we need the
// tail of the screen, including when hc returns more than 4000 runes.
func nexusSanitizeScreen(screen string) string {
	lines := strings.Split(screen, "\n")
	for i := range lines {
		lines[i] = nexusSanitize(lines[i])
	}
	return strings.Join(lines, "\n")
}

// Called only after roster validation, by both route --roster and hook-prompt.
// Workers return values through a buffered channel; only this goroutine mutates
// the roster, including when an uncooperative runner returns after our deadline.
func nexusEnrichRoster(ctx context.Context, hc nexusHCRunner, roster []nexusRosterEntry, panes HUDPanes, fetched ...[]bool) []nexusRosterEntry {
	out := append([]nexusRosterEntry(nil), roster...)
	n := min(len(out), nexusContextHeads)
	screens := make([]string, n)
	completed := make([]int, n)
	defer func() {
		for i := range screens {
			out[i].Recent = nexusRecent(screens[i], out[i].Report)
			if len(fetched) > 0 {
				fetched[0][i] = completed[i] == 2
			}
		}
	}()
	for i := range out {
		if i >= n {
			out[i].Cwd, out[i].Report, out[i].Recent = "", "", ""
			continue
		}
		for _, t := range panes.Terminals {
			if t.Address == out[i].Address && t.Cwd != "" {
				out[i].Cwd = t.Cwd
				break
			}
		}
		out[i].Cwd = nexusContextCwd(out[i].Cwd)
		out[i].Report = nexusContextReport(out[i].Report)
		screens[i] = out[i].Recent
	}
	if hc == nil || n == 0 {
		return out
	}
	ctx, cancel := context.WithTimeout(ctx, nexusContextBudget)
	defer cancel()
	type result struct {
		index  int
		detail bool
		raw    []byte
		ok     bool
	}
	results := make(chan result, 2*n)
	for i := 0; i < n; i++ {
		address := out[i].Address
		go func(i int) {
			raw, err := hc(ctx, "get", address, "--json")
			if err == nil {
				results <- result{i, true, raw, true}
			} else {
				results <- result{index: i, detail: true}
			}
		}(i)
		go func(i int) {
			raw, err := hc(ctx, "read", address, "--lines", "0")
			if err == nil {
				results <- result{i, false, raw, true}
			} else {
				results <- result{index: i}
			}
		}(i)
	}
	for remaining := 2 * n; remaining > 0; remaining-- {
		select {
		case <-ctx.Done():
			return out
		case r := <-results:
			if !r.ok {
				continue
			}
			if !r.detail {
				completed[r.index]++
				screens[r.index] = string(r.raw)
				continue
			}
			var detail struct {
				Cwd        string `json:"cwd"`
				Title      string `json:"title"`
				Report     string `json:"report"`
				Foreground struct {
					Cwd string `json:"cwd"`
				} `json:"foreground"`
				Status struct {
					Report string `json:"report"`
				} `json:"status"`
			}
			if json.Unmarshal(r.raw, &detail) != nil {
				continue
			}
			completed[r.index]++
			cwd := detail.Foreground.Cwd
			if cwd == "" {
				cwd = detail.Cwd
			}
			if cwd != "" {
				out[r.index].Cwd = nexusContextCwd(cwd)
			}
			for _, candidate := range []string{detail.Status.Report, detail.Report, detail.Title} {
				if report := nexusContextReport(candidate); report != "" {
					out[r.index].Report = report
					break
				}
			}
		}
	}
	return out
}

func nexusPendingAsk(logs []nexusLogEntry, now time.Time) *nexusLogEntry {
	if len(logs) == 0 {
		return nil
	}
	last := &logs[len(logs)-1]
	if last.Action != "ask" || last.Message == "" {
		return nil
	}
	at, err := time.Parse(time.RFC3339, last.At)
	if err != nil || now.Before(at) || now.Sub(at) > 90*time.Second {
		return nil
	}
	return last
}

// Context entries contain only bounded topic hints, never routing authority.
type nexusContextEntry struct {
	At     time.Time `json:"at"`
	Cwd    string    `json:"cwd"`
	Report string    `json:"report"`
	Recent string    `json:"recent"`
}

func nexusCachedRoster(ctx context.Context, hc nexusHCRunner, roster []nexusRosterEntry, panes HUDPanes, path string, now time.Time, force bool, readOnly ...bool) ([]nexusRosterEntry, error) {
	cached := map[string]nexusContextEntry{}
	raw, _ := os.ReadFile(path)
	_ = json.Unmarshal(raw, &cached)
	out := nexusEnrichRoster(ctx, nil, roster, panes)
	missing := []nexusRosterEntry{}
	indices := []int{}
	next := map[string]nexusContextEntry{}
	for i := 0; i < min(len(out), nexusContextHeads); i++ {
		r := &out[i]
		c, ok := cached[r.Address]
		if ok && !now.Before(c.At) && now.Sub(c.At) < 10*time.Minute && (c.Cwd != "" || c.Report != "" || c.Recent != "") {
			next[r.Address] = c
		} else {
			ok = false
		}
		if !force && ok && !now.Before(c.At) && now.Sub(c.At) < 20*time.Second {
			r.Cwd, r.Report, r.Recent = c.Cwd, c.Report, c.Recent
			next[r.Address] = c
		} else {
			missing = append(missing, *r)
			indices = append(indices, i)
		}
	}
	if len(missing) > 0 {
		fetched := make([]bool, len(missing))
		enriched := nexusEnrichRoster(ctx, hc, missing, panes, fetched)
		for j, r := range enriched {
			out[indices[j]] = r
			if fetched[j] && (r.Cwd != "" || r.Report != "" || r.Recent != "") {
				next[r.Address] = nexusContextEntry{now, r.Cwd, r.Report, r.Recent}
			} else if c, ok := next[r.Address]; ok {
				out[indices[j]].Cwd, out[indices[j]].Report, out[indices[j]].Recent = c.Cwd, c.Report, c.Recent
			}
		}
	}
	// Reapply bounds to untrusted disk content, and discard departed addresses.
	out = nexusEnrichRoster(ctx, nil, out, HUDPanes{})
	if len(readOnly) > 0 && readOnly[0] {
		return out, nil
	}
	raw, err := json.Marshal(next)
	if err == nil {
		err = nexusAtomic(path, raw)
	}
	return out, err
}

func nexusContextWarm(ctx context.Context, sharedPath, cache string, hc nexusHCRunner) error {
	if err := os.MkdirAll(cache, 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(cache, "nexus-context.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil
		}
		return err
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	raw, err := os.ReadFile(sharedPath)
	if err != nil {
		return err
	}
	var shared nexusShared
	if err = json.Unmarshal(raw, &shared); err != nil {
		return err
	}
	roster := []nexusRosterEntry{}
	seen := map[string]bool{}
	for _, h := range shared.Heads {
		if h.Address == "" || strings.Contains(h.Address, "/") || seen[h.Address] {
			continue
		}
		seen[h.Address] = true
		roster = append(roster, nexusRosterEntry{Address: h.Address})
	}
	_, err = nexusCachedRoster(ctx, hc, roster, HUDPanes{}, filepath.Join(cache, "nexus-context.json"), time.Now(), true)
	return err
}

func nexusContextSpawnWarm() error {
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer null.Close()
	cmd := exec.Command(binary, "nexus", "context", "warm")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = null, null, null
	if err = cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func nexusRouterEffort(key, override string) string {
	if key == "haiku" || key == "claude-haiku" {
		return ""
	}
	switch override {
	case "low", "medium", "high":
		return override
	}
	return "low"
}

func nexusRouterEffortArgs(key, effort string) []string {
	effort = nexusRouterEffort(key, effort)
	if effort == "" {
		return nil
	}
	if strings.HasPrefix(key, "codex-") {
		return []string{"-c", "model_reasoning_effort=" + effort}
	}
	return []string{"--effort", effort}
}
