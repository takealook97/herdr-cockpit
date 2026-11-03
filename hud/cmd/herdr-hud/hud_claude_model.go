package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

var hudClaudeProjectChar = regexp.MustCompile(`[^A-Za-z0-9]`)
var hudClaudeVersion = regexp.MustCompile(`^(.*)-([0-9]+)-([0-9]+)$`)
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
	if home == "" {
		user, err := os.UserHomeDir()
		if err != nil {
			return "", ""
		}
		home = filepath.Join(user, ".claude")
	}
	rawSession, err := os.ReadFile(filepath.Join(home, "sessions", strconv.Itoa(pid)+".json"))
	if err != nil {
		return "", ""
	}
	var session struct {
		PID       int    `json:"pid"`
		SessionID string `json:"sessionId"`
		Cwd       string `json:"cwd"`
	}
	if json.Unmarshal(rawSession, &session) != nil || session.PID != pid || session.Cwd == "" || session.SessionID == "" || strings.ContainsAny(session.SessionID, `/\`) || session.SessionID == "." || session.SessionID == ".." {
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
	if entry, ok := cache[key]; ok && entry.Mtime == info.ModTime().UnixNano() && entry.Size == info.Size() {
		return entry.Model, entry.Effort
	}
	readOK := false
	defer func() {
		if !readOK {
			return
		}
		cache[key] = hudClaudeCacheEntry{info.ModTime().UnixNano(), info.Size(), model, effort}
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
			Model         string `json:"model"`
			Effort        string `json:"effort"`
			PerTurnEffort string `json:"perTurnEffort"`
			Message       struct {
				Model string `json:"model"`
			} `json:"message"`
		}
		if json.Unmarshal(lines[i], &record) != nil {
			continue
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
	return model, effort
}

var hudClaudeCacheMu sync.Mutex

type hudClaudeCacheEntry struct {
	Mtime  int64  `json:"mtime"`
	Size   int64  `json:"size"`
	Model  string `json:"model"`
	Effort string `json:"effort"`
}

func hudClaudeCachePath() string {
	return filepath.Join(hudCacheDir(), "claude-models.json")
}
