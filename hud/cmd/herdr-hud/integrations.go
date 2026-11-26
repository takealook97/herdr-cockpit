package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	roleRecon       = "recon"
	roleDesign      = "design"
	roleProduce     = "produce"
	roleIntegrate   = "integrate"
	roleMech        = "verify-mech"
	roleCritical    = "verify-critical"
	roleNeutral     = "verify-neutral"
	roleAdversarial = "verify-adversarial"
)

func hudCacheDir() string {
	root := os.Getenv("XDG_CACHE_HOME")
	if root == "" {
		home, _ := os.UserHomeDir()
		root = filepath.Join(home, ".cache")
	}
	return filepath.Join(root, "herdr-hud")
}

// Only the public run metadata needed by the UI is decoded. No orch code is linked.
type Worker struct {
	Terminal string `json:"terminal"`
	Pane     string `json:"pane"`
	Name     string `json:"name"`
	Key      string `json:"key"`
	Family   string `json:"family"`
	Role     string `json:"role"`
	Purpose  string `json:"purpose"`
	Status   string `json:"status"`
}
type Run struct {
	ID        string    `json:"id"`
	HeadPane  string    `json:"head_pane"`
	Workspace string    `json:"workspace"`
	Tab       string    `json:"tab"`
	Mode      string    `json:"mode"`
	Status    string    `json:"status"`
	Workers   []*Worker `json:"workers"`
}

func runDir(id string) string {
	root := os.Getenv("ORCH_HOME")
	if root == "" {
		home, _ := os.UserHomeDir()
		root = filepath.Join(home, ".orch")
	}
	return filepath.Join(root, "runs", id)
}
func allRuns() ([]*Run, error) {
	entries, err := os.ReadDir(runDir(""))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	out := []*Run{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(runDir(entry.Name()), "run.json"))
		if err != nil {
			continue
		}
		var run Run
		if json.Unmarshal(raw, &run) == nil && run.Status == "active" {
			out = append(out, &run)
		}
	}
	return out, nil
}

type hudCatalogModel struct {
	Key     string `json:"key"`
	Model   string `json:"model"`
	Display string `json:"display"`
	Effort  string `json:"effort"`
}

// The catalog is loaded once per process when it succeeds. A failed or empty load
// is retried after hudCatalogRetry so a transient orch error recovers without
// spawning orch on every refresh. The mutex makes concurrent callers share one load.
// Space Tree starts a fresh helper per poll, so results are also kept in a small
// disk cache: a success for hudCatalogTTL, a failure for hudCatalogRetry, both keyed
// by a digest of the lookup inputs. Without a usable cache dir it stays in memory.
var (
	hudCatalogMu      sync.Mutex
	hudCatalogCache   map[string]hudCatalogModel
	hudCatalogFailed  time.Time
	hudCatalogRetry   = 30 * time.Second
	hudCatalogTTL     = 5 * time.Minute
	hudCatalogNow     = time.Now
	hudCatalogTimeout = 2 * time.Second
)

type hudCatalogDisk struct {
	Source string                     `json:"source"`
	Saved  int64                      `json:"saved"`
	Models map[string]hudCatalogModel `json:"models,omitempty"`
}

func hudCatalogDiskPath() string { return filepath.Join(hudCacheDir(), "orch-catalog.json") }

// hudCatalogSource digests what decides the catalog: the resolved executable and
// its identity, the models file identity, and orch/model environment overrides.
// Only the digest is stored, never environment values.
func hudCatalogSource(orchPath string) string {
	h := sha256.New()
	stamp := func(path string) {
		fmt.Fprintf(h, "%s\x00", path)
		if info, err := os.Stat(path); err == nil {
			fmt.Fprintf(h, "%d\x00%d\x00", info.Size(), info.ModTime().UnixNano())
		}
	}
	stamp(orchPath)
	models := os.Getenv("ORCH_MODELS_FILE")
	if models == "" {
		root := os.Getenv("ORCH_HOME")
		if root == "" {
			home, _ := os.UserHomeDir()
			root = filepath.Join(home, ".orch")
		}
		models = filepath.Join(root, "models.yaml")
	}
	stamp(models)
	var env []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "ORCH_") || strings.HasPrefix(kv, "CODEX_") || strings.HasPrefix(kv, "CLAUDE_") {
			env = append(env, kv)
		}
	}
	sort.Strings(env)
	fmt.Fprintf(h, "%s", strings.Join(env, "\x00"))
	return hex.EncodeToString(h.Sum(nil))
}

// hudCatalogFromDisk reports a fresh cached result: models (nil for a cached failure).
func hudCatalogFromDisk(source string) (map[string]hudCatalogModel, bool) {
	raw, err := os.ReadFile(hudCatalogDiskPath())
	if err != nil {
		return nil, false
	}
	var disk hudCatalogDisk
	if json.Unmarshal(raw, &disk) != nil || disk.Source != source {
		return nil, false
	}
	age := hudCatalogNow().Sub(time.Unix(0, disk.Saved))
	ttl := hudCatalogRetry
	if len(disk.Models) > 0 {
		ttl = hudCatalogTTL
	}
	if age < 0 || age >= ttl {
		return nil, false
	}
	return disk.Models, true
}

func hudCatalogToDisk(source string, models map[string]hudCatalogModel) {
	raw, err := json.Marshal(hudCatalogDisk{Source: source, Saved: hudCatalogNow().UnixNano(), Models: models})
	if err == nil {
		_ = hudWritePrivateFile(hudCatalogDiskPath(), raw)
	}
}

// hudOrchPath resolves orch even when a GUI host starts the helper with a bare PATH.
func hudOrchPath() string {
	if path, err := exec.LookPath("orch"); err == nil {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	path := filepath.Join(home, ".local", "bin", "orch")
	if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
		return path
	}
	return ""
}

func hudCatalog(ctx context.Context) map[string]hudCatalogModel {
	hudCatalogMu.Lock()
	defer hudCatalogMu.Unlock()
	if len(hudCatalogCache) > 0 {
		return hudCatalogCache
	}
	if !hudCatalogFailed.IsZero() && hudCatalogNow().Sub(hudCatalogFailed) < hudCatalogRetry {
		return map[string]hudCatalogModel{}
	}
	path := hudOrchPath()
	source := hudCatalogSource(path)
	loaded, cached := hudCatalogFromDisk(source)
	if !cached {
		loaded = hudLoadCatalog(ctx, path)
		hudCatalogToDisk(source, loaded)
	}
	if len(loaded) == 0 {
		hudCatalogFailed = hudCatalogNow()
		return map[string]hudCatalogModel{}
	}
	hudCatalogCache, hudCatalogFailed = loaded, time.Time{}
	return hudCatalogCache
}

func hudLoadCatalog(ctx context.Context, path string) map[string]hudCatalogModel {
	if path == "" {
		return nil
	}
	child, cancel := context.WithTimeout(ctx, hudCatalogTimeout)
	defer cancel()
	raw, err := exec.CommandContext(child, path, "models", "--json").Output()
	if err != nil {
		return nil
	}
	var models []hudCatalogModel
	if json.Unmarshal(raw, &models) != nil {
		return nil
	}
	out := map[string]hudCatalogModel{}
	for _, model := range models {
		if model.Key != "" {
			out[model.Key] = model
		}
	}
	return out
}
