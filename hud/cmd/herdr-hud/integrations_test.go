package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// resetHUDCatalog isolates the process catalog and hides any developer
// installation (PATH and ~/.local/bin) from the test.
func resetHUDCatalog(t *testing.T) {
	t.Helper()
	reset := func() { hudCatalogCache, hudCatalogFailed, hudCatalogNow = nil, time.Time{}, time.Now }
	reset()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Cleanup(reset)
}

// coldHUDCatalog drops in-memory state as a fresh helper process would, keeping the disk cache.
func coldHUDCatalog() { hudCatalogCache, hudCatalogFailed = nil, time.Time{} }

func countCalls(t *testing.T, path string) int {
	t.Helper()
	raw, _ := os.ReadFile(path)
	return strings.Count(string(raw), "x")
}

func TestHUDCatalogDiskCacheAcrossProcesses(t *testing.T) {
	resetHUDCatalog(t)
	bin, dir := t.TempDir(), t.TempDir()
	calls := filepath.Join(dir, "calls")
	t.Setenv("PATH", bin)
	t.Setenv("CALLS", calls)
	writeCatalogBin(t, bin, "#!/bin/sh\necho x >> \"$CALLS\"\n"+hudTestCatalogBody)
	now := time.Unix(1000, 0)
	hudCatalogNow = func() time.Time { return now }
	key := "claude-medium-m"
	for i := 0; i < 3; i++ {
		coldHUDCatalog()
		if hudCatalog(context.Background())[key].Effort != "medium" {
			t.Fatal("cached catalog must resolve")
		}
		now = now.Add(3 * time.Second)
	}
	if n := countCalls(t, calls); n != 1 {
		t.Fatalf("fresh helpers must share the disk cache, got %d calls", n)
	}
	// Expiry: after the TTL a fresh helper requeries.
	now = now.Add(hudCatalogTTL)
	coldHUDCatalog()
	hudCatalog(context.Background())
	if n := countCalls(t, calls); n != 2 {
		t.Fatalf("expired cache must requery, got %d calls", n)
	}
	// Input change: an override or a reinstalled executable invalidates the cache.
	t.Setenv("ORCH_MODELS_FILE", filepath.Join(dir, "models.yaml"))
	coldHUDCatalog()
	hudCatalog(context.Background())
	if n := countCalls(t, calls); n != 3 {
		t.Fatalf("models file change must requery, got %d calls", n)
	}
	writeCatalogBin(t, bin, "#!/bin/sh\necho x >> \"$CALLS\"\necho x >> \"$CALLS\"\n"+hudTestCatalogBody)
	coldHUDCatalog()
	hudCatalog(context.Background())
	if n := countCalls(t, calls); n != 5 {
		t.Fatalf("reinstalled orch must requery, got %d calls", n)
	}
	raw, err := os.ReadFile(hudCatalogDiskPath())
	if err != nil || strings.Contains(string(raw), dir) {
		t.Fatalf("cache must exist and hold no environment values: %v %s", err, raw)
	}
}

func TestHUDCatalogDiskFailureBackoff(t *testing.T) {
	resetHUDCatalog(t)
	bin, dir := t.TempDir(), t.TempDir()
	calls := filepath.Join(dir, "calls")
	t.Setenv("PATH", bin)
	t.Setenv("CALLS", calls)
	writeCatalogBin(t, bin, "#!/bin/sh\necho x >> \"$CALLS\"\nexit 3\n")
	now := time.Unix(1000, 0)
	hudCatalogNow = func() time.Time { return now }
	for i := 0; i < 3; i++ {
		coldHUDCatalog()
		if len(hudCatalog(context.Background())) != 0 {
			t.Fatal("failing catalog must be empty")
		}
		now = now.Add(3 * time.Second)
	}
	if n := countCalls(t, calls); n != 1 {
		t.Fatalf("failure must back off across helpers, got %d calls", n)
	}
	now = now.Add(hudCatalogRetry)
	coldHUDCatalog()
	hudCatalog(context.Background())
	if n := countCalls(t, calls); n != 2 {
		t.Fatalf("failure must be retried after the window, got %d calls", n)
	}
}

func TestHUDCatalogNoDiskStillWorks(t *testing.T) {
	resetHUDCatalog(t)
	blocked := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocked, nil, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_CACHE_HOME", blocked)
	bin := t.TempDir()
	t.Setenv("PATH", bin)
	writeCatalogBin(t, bin, hudTestCatalogScript)
	if hudCatalog(context.Background())["claude-medium-m"].Effort != "medium" {
		t.Fatal("unwritable cache dir must fall back to memory")
	}
}

const hudTestCatalogBody = `printf '%s\n' '[{"key":"claude-medium-m","model":"opus-5.5","display":"opus-5.5","effort":"medium"}]'
`
const hudTestCatalogScript = "#!/bin/sh\n[ \"$1\" = models ] && [ \"$2\" = --json ] || exit 1\n" + hudTestCatalogBody

func writeCatalogBin(t *testing.T, dir, script string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "orch"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
}

func TestHUDCatalogOptional(t *testing.T) {
	resetHUDCatalog(t)
	bin := t.TempDir()
	t.Setenv("PATH", bin)
	now := time.Unix(1000, 0)
	hudCatalogNow = func() time.Time { return now }
	if len(hudCatalog(context.Background())) != 0 {
		t.Fatal("missing catalog must be empty")
	}
	// A failure is throttled: an executable appearing within the retry window is not queried yet.
	writeCatalogBin(t, bin, hudTestCatalogScript)
	if len(hudCatalog(context.Background())) != 0 {
		t.Fatal("failed lookup must back off")
	}
	now = now.Add(hudCatalogRetry)
	got := hudCatalog(context.Background())["claude-medium-m"]
	if got.Display != "opus-5.5" || got.Effort != "medium" {
		t.Fatalf("catalog after retry: %+v", got)
	}
	// A warm hit never requeries, even after the executable breaks and time passes.
	writeCatalogBin(t, bin, "#!/bin/sh\nprintf invalid\n")
	now = now.Add(time.Hour)
	if hudCatalog(context.Background())[got.Key] != got {
		t.Fatal("must reuse parsed catalog")
	}
}

func TestHUDCatalogInvalidOutputs(t *testing.T) {
	for name, script := range map[string]string{
		"malformed": "#!/bin/sh\nprintf invalid\n",
		"empty":     "#!/bin/sh\nprintf '[]'\n",
		"failing":   "#!/bin/sh\nexit 3\n",
		"no keys":   "#!/bin/sh\nprintf '[{\"model\":\"x\"}]'\n",
	} {
		t.Run(name, func(t *testing.T) {
			resetHUDCatalog(t)
			bin := t.TempDir()
			t.Setenv("PATH", bin)
			writeCatalogBin(t, bin, script)
			now := time.Unix(1000, 0)
			hudCatalogNow = func() time.Time { return now }
			if len(hudCatalog(context.Background())) != 0 {
				t.Fatal("invalid catalog must be empty")
			}
			// The same process recovers once the lookup succeeds after the retry window.
			writeCatalogBin(t, bin, hudTestCatalogScript)
			now = now.Add(hudCatalogRetry)
			if hudCatalog(context.Background())["claude-medium-m"].Effort != "medium" {
				t.Fatal("must recover after transient failure")
			}
		})
	}
}

func TestHUDCatalogMinimalPATHUsesLocalBin(t *testing.T) {
	resetHUDCatalog(t)
	home := os.Getenv("HOME")
	t.Setenv("PATH", t.TempDir())
	writeCatalogBin(t, filepath.Join(home, ".local", "bin"), hudTestCatalogScript)
	if hudCatalog(context.Background())["claude-medium-m"].Display != "opus-5.5" {
		t.Fatal("~/.local/bin executable must be found with a minimal PATH")
	}
	if !hudOrchAvailable() {
		t.Fatal("~/.local/bin executable must enable integration")
	}
}

func TestHUDCatalogConcurrentSingleLoad(t *testing.T) {
	// PATH holds only the fake orch, so the delay must use an absolute path.
	sleepCmd, err := exec.LookPath("sleep")
	if err != nil {
		t.Skip("sleep unavailable")
	}
	resetHUDCatalog(t)
	bin, dir := t.TempDir(), t.TempDir()
	t.Setenv("PATH", bin)
	t.Setenv("CALLS", filepath.Join(dir, "calls"))
	writeCatalogBin(t, bin, "#!/bin/sh\necho x >> \"$CALLS\"\n"+sleepCmd+" 0.2\n"+hudTestCatalogBody)
	start := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); hudCatalog(context.Background()) }()
	}
	wg.Wait()
	if time.Since(start) < 150*time.Millisecond {
		t.Fatal("fake orch delay did not run")
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "calls"))
	if n := strings.Count(string(raw), "x"); n != 1 {
		t.Fatalf("catalog command invoked %d times", n)
	}
}

func TestHUDPanesRawKeyWithoutCatalog(t *testing.T) {
	resetHUDCatalog(t)
	t.Setenv("PATH", t.TempDir())
	t.Setenv("ORCH_HOME", t.TempDir())
	run := &Run{ID: "r1", Status: "active", Workers: []*Worker{{Terminal: "w1", Key: "claude-top-h"}}}
	if err := os.MkdirAll(runDir(run.ID), 0700); err != nil {
		t.Fatal(err)
	}
	if err := saveRun(run); err != nil {
		t.Fatal(err)
	}
	out := hudPanes(context.Background())
	if len(out.Runs) != 1 || out.Runs[0].Workers[0].Model != "claude-top-h" || out.Runs[0].Workers[0].Effort != "" {
		t.Fatalf("degraded worker: %+v", out.Runs)
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
