package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func resetHUDCatalog(t *testing.T) {
	t.Helper()
	hudCatalogOnce = sync.Once{}
	hudCatalogCache = nil
	t.Cleanup(func() { hudCatalogOnce = sync.Once{}; hudCatalogCache = nil })
}

func TestHUDCatalogOptional(t *testing.T) {
	resetHUDCatalog(t)
	bin := t.TempDir()
	t.Setenv("PATH", bin)
	if len(hudCatalog(context.Background())) != 0 {
		t.Fatal("missing catalog must be empty")
	}
	// A failed lookup is also cached for this short-lived helper process.
	path := filepath.Join(bin, "orch")
	script := `#!/bin/sh
[ "$1" = models ] && [ "$2" = --json ] || exit 1
printf '%s\n' '[{"key":"claude-medium-m","model":"opus-5.5","display":"opus-5.5","effort":"medium"}]'
`
	if err := os.WriteFile(path, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	if len(hudCatalog(context.Background())) != 0 {
		t.Fatal("must cache lookup per process")
	}
	hudCatalogOnce = sync.Once{}
	got := hudCatalog(context.Background())["claude-medium-m"]
	if got.Display != "opus-5.5" || got.Effort != "medium" {
		t.Fatalf("catalog: %+v", got)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf invalid\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if hudCatalog(context.Background())[got.Key] != got {
		t.Fatal("must reuse parsed catalog")
	}
	hudCatalogOnce = sync.Once{}
	if len(hudCatalog(context.Background())) != 0 {
		t.Fatal("invalid JSON must be ignored")
	}
}

func TestHUDPanesVanilla(t *testing.T) {
	resetHUDCatalog(t)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCH_HOME", "")
	bin := t.TempDir()
	t.Setenv("PATH", bin)
	script := `#!/bin/sh
if [ "$1" = ls ]; then
 printf '%s\n' '{"terminals":[{"address":"t1","program":"codex"},{"address":"t2","program":"zsh"}]}'
else
 printf '%s\n' '{"argv":["codex","--model","example-model","-c","model_reasoning_effort=low"]}'
fi
`
	if err := os.WriteFile(filepath.Join(bin, "hc"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	out := hudPanes(context.Background())
	if out.Error != "" || len(out.Runs) != 0 || len(out.Terminals) != 1 {
		t.Fatalf("panes: %+v", out)
	}
	if got := out.Terminals[0]; got.Program != "codex" || got.Model != "example-model" || got.Effort != "low" {
		t.Fatalf("terminal: %+v", got)
	}
}

// Test fixtures write run metadata; the installed helper only reads it.
func saveRun(run *Run) error {
	raw, err := json.Marshal(run)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(runDir(run.ID), "run.json"), raw, 0600)
}

func TestHUDCacheLocation(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", root)
	if got := hudCacheDir(); got != filepath.Join(root, "herdr-hud") {
		t.Fatal(got)
	}
	t.Setenv("XDG_CACHE_HOME", "")
	t.Setenv("HOME", root)
	if got := hudCacheDir(); got != filepath.Join(root, ".cache", "herdr-hud") {
		t.Fatal(got)
	}
}
