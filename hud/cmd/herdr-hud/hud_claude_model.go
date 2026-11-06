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
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
)

var hudClaudeProjectChar = regexp.MustCompile(`[^A-Za-z0-9]`)
var hudClaudeVersion = regexp.MustCompile(`^(.*)-([0-9]+)-([0-9]+)$`)
var hudClaudeCommandOutput = regexp.MustCompile(`(?s)<local-command-stdout>(.*?)</local-command-stdout>`)
var hudClaudeCommandModel = regexp.MustCompile(`(?i)\bSet model to\s+` + "`" + `?([a-z][a-z0-9_-]*)(?:\s+([0-9]+(?:\.[0-9]+)*))?` + "`" + `?`)
var hudClaudeCommandEffort = regexp.MustCompile(`(?i)\bSet effort (?:level )?to\s+` + "`" + `?(low|medium|high|xhigh|max)\b`)
var hudClaudeModelEffort = regexp.MustCompile(`(?i)\bwith\s+(low|medium|high|xhigh|max)\s+effort\b`)
var hudClaudeDate = regexp.MustCompile(`-[0-9]{8}$`)

func hudModelDisplay(id string) string {
	if !strings.HasPrefix(id, "claude-") {
		return id
	}
	name := hudClaudeDate.ReplaceAllString(strings.TrimPrefix(id, "claude-"), "")
	if parts := hudClaudeVersion.FindStringSubmatch(name); parts != nil {
		return parts[1] + "-" + parts[2] + "." + parts[3]
	}
	return name
}

// Resolve only family aliases; exact IDs and unknown aliases stay unchanged.
func hudClaudeCatalogModel(ctx context.Context, model string) string {
	family := strings.ToLower(model)
	family = strings.TrimSuffix(family, "[1m]")
	family = strings.TrimPrefix(family, "claude-")
	if family == "opusplan" {
		family = "opus"
	}
	if family != "opus" && family != "sonnet" && family != "haiku" {
		return model
	}
	catalog := hudCatalog(ctx)
	keys := make([]string, 0, len(catalog))
	for key := range catalog {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		id := catalog[key].Model
		if strings.HasPrefix(id, "claude-"+family+"-") && hudClaudeVersion.MatchString(hudClaudeDate.ReplaceAllString(id, "")) {
			return id
		}
	}
	return model
}

type hudClaudeSession struct {
	PID         int    `json:"pid"`
	SessionID   string `json:"sessionId"`
	Cwd         string `json:"cwd"`
	Model       string `json:"model"`
	Effort      string `json:"effort"`
	EffortLevel string `json:"effortLevel"`
}

func hudClaudeHome(home string) string {
	if home == "" {
		user, err := os.UserHomeDir()
		if err == nil {
			return filepath.Join(user, ".claude")
		}
	}
	return home
}

// Settings and session metadata are small local files; reject oversized or
// non-regular inputs rather than letting fallback discovery read unbounded data.
func hudClaudeReadMetadata(path string, value any) bool {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 64*1024 {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, 64*1024+1))
	return err == nil && len(raw) <= 64*1024 && json.Unmarshal(raw, value) == nil
}

func hudClaudeReadSession(home string, pid int) hudClaudeSession {
	var session hudClaudeSession
	if pid <= 0 || !hudClaudeReadMetadata(filepath.Join(home, "sessions", strconv.Itoa(pid)+".json"), &session) || session.PID != pid {
		return hudClaudeSession{}
	}
	return session
}

// Settings models are display identifiers, never terminal control sequences.
func hudClaudeSettingsModel(value string) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, value)
	for _, r := range value {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("._:-", r)) {
			return ""
		}
	}
	if len(value) > 40 {
		value = value[:40]
	}
	return value
}

// Resolve each field independently. Live transcript metadata wins; launch argv
// stays ahead of process env and settings, which only fill missing information.
// An unchanged argv field returns empty so worker catalog values stay intact.
// The caller resolves family aliases through the optional model catalog.
func hudClaudeResolve(home string, pid int, cwd, env, launchModel, launchEffort string) (model, effort string) {
	if pid <= 0 {
		return "", ""
	}
	home = hudClaudeHome(home)
	session := hudClaudeReadSession(home, pid)
	if session.Cwd != "" {
		cwd = session.Cwd
	}
	if home != "" {
		paths := []string{filepath.Join(home, "settings.json")}
		if filepath.IsAbs(cwd) {
			paths = append(paths, filepath.Join(cwd, ".claude", "settings.json"), filepath.Join(cwd, ".claude", "settings.local.json"))
		}
		for _, path := range paths {
			var settings struct {
				Model       string `json:"model"`
				EffortLevel string `json:"effortLevel"`
			}
			if hudClaudeReadMetadata(path, &settings) {
				if safe := hudClaudeSettingsModel(settings.Model); safe != "" {
					model = safe
				}
				if settings.EffortLevel != "" {
					effort = settings.EffortLevel
				}
			}
		}
	}
	for _, value := range []string{hudEnvValue(env, "CLAUDE_MODEL"), hudEnvValue(env, "ANTHROPIC_MODEL")} {
		if value != "" {
			model = value
		}
	}
	if session.Model != "" {
		model = session.Model
	}
	if value := hudEnvValue(env, "CLAUDE_CODE_EFFORT_LEVEL"); value != "" {
		effort = value
	}
	for _, value := range []string{session.EffortLevel, session.Effort} {
		if value != "" {
			effort = value
		}
	}
	if launchModel != "" {
		model = ""
	}
	if launchEffort != "" {
		effort = ""
	}
	liveModel, liveEffort := hudClaudeTranscript(home, pid)
	if liveModel != "" {
		model = liveModel
	}
	if liveEffort != "" {
		effort = liveEffort
	}
	return model, effort
}

// Read a bounded tail only; incomplete JSON written by the running agent is ignored.
func hudClaudeTranscriptModel(home string, pid int) string {
	model, _ := hudClaudeTranscript(home, pid)
	return model
}

// hudClaudeTranscript returns the newest model id and reasoning effort recorded in the session.
// Effort set with /effort is only visible here, never on the launch argv.
func hudClaudeTranscript(home string, pid int) (model, effort string) {
	if pid <= 0 {
		return "", ""
	}
	home = hudClaudeHome(home)
	if home == "" {
		return "", ""
	}
	session := hudClaudeReadSession(home, pid)
	if session.Cwd == "" || session.SessionID == "" || strings.ContainsAny(session.SessionID, `/\`) || session.SessionID == "." || session.SessionID == ".." {
		return "", ""
	}
	dir := filepath.Join(home, "projects", hudClaudeProjectChar.ReplaceAllString(session.Cwd, "-"))
	path := filepath.Join(dir, session.SessionID+".jsonl")
	info, err := os.Stat(path)
	if err != nil {
		return "", ""
	}
	hudClaudeCacheMu.Lock()
	defer hudClaudeCacheMu.Unlock()
	cachePath := hudClaudeCachePath()
	cache := map[string]hudClaudeCacheEntry{}
	if raw, err := os.ReadFile(cachePath); err == nil {
		_ = json.Unmarshal(raw, &cache)
	}
	if cache == nil {
		cache = map[string]hudClaudeCacheEntry{}
	}
	key := fmt.Sprintf("%d:%s", pid, path)
	entry := hudClaudeCacheEntry{Version: 2, Mtime: info.ModTime().UnixNano(), Size: info.Size()}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		entry.Device, entry.Inode = uint64(stat.Dev), uint64(stat.Ino)
	}
	previous, ok := cache[key]
	same := ok && previous.Version == entry.Version && previous.Device == entry.Device && previous.Inode == entry.Inode
	if same && previous.Mtime == entry.Mtime && previous.Size == entry.Size {
		return previous.Model, previous.Effort
	}
	// Retain metadata outside the tail only while the same transcript grows.
	retainedModel, retainedEffort := "", ""
	if same && entry.Size > previous.Size {
		retainedModel, retainedEffort = previous.Model, previous.Effort
	}
	readOK := false
	defer func() {
		if !readOK {
			return
		}
		entry.Model, entry.Effort = model, effort
		cache[key] = entry
		if len(cache) > 256 {
			cache = map[string]hudClaudeCacheEntry{key: cache[key]}
		}
		raw, err := json.Marshal(cache)
		if err != nil || os.MkdirAll(filepath.Dir(cachePath), 0700) != nil {
			return
		}
		f, err := os.CreateTemp(filepath.Dir(cachePath), ".claude-models-*")
		if err != nil {
			return
		}
		name := f.Name()
		defer os.Remove(name)
		if _, err := f.Write(raw); err != nil {
			f.Close()
			return
		}
		if f.Close() == nil {
			_ = os.Rename(name, cachePath)
		}
	}()
	f, err := os.Open(path)
	if err != nil {
		return "", ""
	}
	defer f.Close()
	offset := info.Size() - 256*1024
	if offset < 0 {
		offset = 0
	}
	if _, err = f.Seek(offset, io.SeekStart); err != nil {
		return "", ""
	}
	raw, err := io.ReadAll(io.LimitReader(f, 256*1024))
	if err != nil {
		return "", ""
	}
	readOK = true
	lines := bytes.Split(raw, []byte{'\n'})
	// A tail starting mid-record cannot be trusted as a complete JSONL record.
	if offset > 0 && len(lines) > 0 {
		lines = lines[1:]
	}
	for i := len(lines) - 1; i >= 0 && (model == "" || effort == ""); i-- {
		var record struct {
			Type          string `json:"type"`
			Model         string `json:"model"`
			Effort        string `json:"effort"`
			PerTurnEffort string `json:"perTurnEffort"`
			Message       struct {
				Model   string          `json:"model"`
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(lines[i], &record) != nil {
			continue
		}
		if record.Type == "user" {
			var content string
			if json.Unmarshal(record.Message.Content, &content) != nil {
				var blocks []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				}
				if json.Unmarshal(record.Message.Content, &blocks) == nil {
					for _, block := range blocks {
						if block.Type == "text" {
							content += block.Text + "\n"
						}
					}
				}
			}
			for _, output := range hudClaudeCommandOutput.FindAllStringSubmatch(content, -1) {
				if match := hudClaudeCommandModel.FindStringSubmatch(output[1]); model == "" && match != nil {
					model = strings.ToLower(match[1])
					if match[2] != "" {
						model += "-" + match[2]
					}
				}
				if effort == "" {
					match := hudClaudeCommandEffort.FindStringSubmatch(output[1])
					if match == nil && hudClaudeCommandModel.MatchString(output[1]) {
						match = hudClaudeModelEffort.FindStringSubmatch(output[1])
					}
					if match != nil {
						effort = strings.ToLower(match[1])
					}
				}
			}
		}
		for _, id := range []string{record.Message.Model, record.Model} {
			if model == "" && strings.HasPrefix(id, "claude-") {
				model = id
			}
		}
		for _, e := range []string{record.PerTurnEffort, record.Effort} {
			if effort == "" && e != "" {
				effort = e
			}
		}
	}
	if model == "" {
		model = retainedModel
	}
	if effort == "" {
		effort = retainedEffort
	}
	return model, effort
}

var hudClaudeCacheMu sync.Mutex

type hudClaudeCacheEntry struct {
	Version int    `json:"version"`
	Device  uint64 `json:"device"`
	Inode   uint64 `json:"inode"`
	Mtime   int64  `json:"mtime"`
	Size    int64  `json:"size"`
	Model   string `json:"model"`
	Effort  string `json:"effort"`
}

func hudClaudeCachePath() string {
	return filepath.Join(hudCacheDir(), "claude-models.json")
}

var hudClaudeBannerPattern = regexp.MustCompile(`(?i)\b(Opus|Sonnet|Haiku)\s+(\d+(?:\.\d+)?)(?:\s+with\s+(low|medium|high|max|xhigh)\s+effort)?`)

func hudClaudeBanner(screen string) (model, effort string) {
	lines := strings.SplitN(screen, "\n", 16)
	if len(lines) > 15 {
		lines = lines[:15]
	}
	if match := hudClaudeBannerPattern.FindStringSubmatch(strings.Join(lines, "\n")); match != nil {
		return strings.ToLower(match[1]) + "-" + match[2], strings.ToLower(match[3])
	}
	return "", ""
}

// Keep consuming stdout while retaining only a bounded screen prefix.
type hudClaudeScreenBuffer struct{ buffer bytes.Buffer }

func (b *hudClaudeScreenBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if remaining := 64*1024 - b.buffer.Len(); remaining > 0 {
		if len(p) > remaining {
			p = p[:remaining]
		}
		_, _ = b.buffer.Write(p)
	}
	return n, nil
}

// Keep banner I/O separate from the transcript cache so a slow hc read cannot
// block live model resolution. The HUD may restart each refresh.
var hudClaudeBannerCacheMu sync.Mutex

// Empty results are cached too, so a missing banner never causes repeated reads.
func hudClaudeStartupBanner(ctx context.Context, pid int, address string) (string, string) {
	if pid <= 0 || address == "" || ctx.Err() != nil {
		return "", ""
	}
	hudClaudeBannerCacheMu.Lock()
	defer hudClaudeBannerCacheMu.Unlock()
	path := hudClaudeCachePath() + ".banner"
	cache := map[string]hudClaudeCacheEntry{}
	if f, err := os.Open(path); err == nil {
		raw, err := io.ReadAll(io.LimitReader(f, 1024*1024))
		f.Close()
		if err == nil {
			_ = json.Unmarshal(raw, &cache)
		}
	}
	if cache == nil {
		cache = map[string]hudClaudeCacheEntry{}
	}
	key := fmt.Sprintf("banner:%d:%s", pid, address)
	if entry, ok := cache[key]; ok {
		return entry.Model, entry.Effort
	}
	if ctx.Err() != nil {
		return "", ""
	}
	child, cancel := context.WithTimeout(ctx, 150*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(child, hudHCPath(), "read", address, "--lines", "0")
	var screen hudClaudeScreenBuffer
	cmd.Stdout = &screen
	cmd.WaitDelay = 100 * time.Millisecond
	model, effort := "", ""
	if cmd.Run() == nil {
		model, effort = hudClaudeBanner(screen.buffer.String())
	}
	entry := hudClaudeCacheEntry{Model: model, Effort: effort}
	if len(cache) >= 256 {
		cache = map[string]hudClaudeCacheEntry{}
	}
	cache[key] = entry
	raw, err := json.Marshal(cache)
	if err == nil && os.MkdirAll(filepath.Dir(path), 0700) == nil {
		if f, err := os.CreateTemp(filepath.Dir(path), ".claude-models-*"); err == nil {
			defer os.Remove(f.Name())
			_, err := f.Write(raw)
			closeErr := f.Close()
			if err == nil && closeErr == nil {
				_ = os.Rename(f.Name(), path)
			}
		}
	}
	return model, effort
}
