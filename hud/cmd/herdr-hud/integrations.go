package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
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

var hudCatalogOnce sync.Once
var hudCatalogCache map[string]hudCatalogModel

func hudCatalog(ctx context.Context) map[string]hudCatalogModel {
	hudCatalogOnce.Do(func() {
		hudCatalogCache = map[string]hudCatalogModel{}
		child, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		raw, err := exec.CommandContext(child, "orch", "models", "--json").Output()
		if err != nil {
			return
		}
		var models []hudCatalogModel
		if json.Unmarshal(raw, &models) != nil {
			return
		}
		for _, model := range models {
			hudCatalogCache[model.Key] = model
		}
	})
	return hudCatalogCache
}
