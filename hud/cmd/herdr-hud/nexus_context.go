package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"time"
)

const nexusContextHeads = 8
const nexusContextBudget = 1500 * time.Millisecond

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

func nexusRecent(screen string) string {
	screen = strings.Map(func(r rune) rune {
		if r >= 0x2500 && r <= 0x259f {
			return -1
		}
		return r
	}, nexusSanitizeScreen(screen))
	lines := []string{}
	for _, line := range strings.Split(screen, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) > 3 {
		lines = lines[len(lines)-3:]
	}
	return nexusBound(strings.Join(lines, " / "), 160)
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
func nexusEnrichRoster(ctx context.Context, hc nexusHCRunner, roster []nexusRosterEntry, panes HUDPanes) []nexusRosterEntry {
	out := append([]nexusRosterEntry(nil), roster...)
	n := min(len(out), nexusContextHeads)
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
		out[i].Report = nexusBound(nexusSanitize(out[i].Report), 160)
		out[i].Recent = nexusRecent(out[i].Recent)
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
	}
	results := make(chan result, 2*n)
	for i := 0; i < n; i++ {
		address := out[i].Address
		go func(i int) {
			raw, err := hc(ctx, "get", address, "--json")
			if err == nil {
				results <- result{i, true, raw}
			} else {
				results <- result{index: i, detail: true}
			}
		}(i)
		go func(i int) {
			raw, err := hc(ctx, "read", address, "--lines", "0")
			if err == nil {
				results <- result{i, false, raw}
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
			if len(r.raw) == 0 {
				continue
			}
			if !r.detail {
				out[r.index].Recent = nexusRecent(string(r.raw))
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
			cwd := detail.Foreground.Cwd
			if cwd == "" {
				cwd = detail.Cwd
			}
			if cwd != "" {
				out[r.index].Cwd = nexusContextCwd(cwd)
			}
			report := detail.Status.Report
			if report == "" {
				report = detail.Report
			}
			if report == "" {
				report = detail.Title
			}
			if report != "" {
				out[r.index].Report = nexusBound(nexusSanitize(report), 160)
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
