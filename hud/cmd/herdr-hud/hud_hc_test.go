package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHUDHCDiscovery(t *testing.T) {
	home, bin := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", bin)
	local := filepath.Join(home, ".local", "bin")
	os.MkdirAll(local, 0700)
	fallback := filepath.Join(local, "herdr-core")
	os.WriteFile(fallback, []byte("#!/bin/sh\n"), 0700)
	if got := hudHCPath(); got != fallback {
		t.Fatalf("fallback: %q", got)
	}
	preferred := filepath.Join(local, "hc")
	os.WriteFile(preferred, []byte("#!/bin/sh\n"), 0700)
	if got := hudHCPath(); got != preferred {
		t.Fatalf("local hc: %q", got)
	}
	pathHC := filepath.Join(bin, "hc")
	os.WriteFile(pathHC, []byte("#!/bin/sh\n"), 0700)
	if got := hudHCPath(); got != pathHC {
		t.Fatalf("PATH precedence: %q", got)
	}
}

func TestHUDPanesWithoutHC(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCH_HOME", "")
	t.Setenv("PATH", t.TempDir())
	if hudHCPath() != "" {
		t.Skip("system hc installed")
	}
	out := hudPanes(context.Background())
	if out.HC || out.Error != "" || out.Terminals == nil || len(out.Terminals) != 0 {
		t.Fatalf("panes: %+v", out)
	}
	accounts, err := hudDiscover(context.Background(), "t1", true)
	if err != nil || len(accounts) != 0 {
		t.Fatalf("usage discovery: %+v %v", accounts, err)
	}
}

func TestHUDPanesLabelsAndObservers(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCH_HOME", "")
	bin := t.TempDir()
	t.Setenv("PATH", bin)
	script := `#!/bin/sh
if [ "$1" = ls ]; then
 echo '{"terminals":[{"address":"t1","agent":"codex"},{"address":"t2","agent":"hc"},{"address":"t3","agent":"hc"},{"address":"t4","agent":"zsh"}]}'
elif [ "$2" = t2 ]; then
 echo '{"labels":{"hub.observer":"t1"},"argv":["hc","attach"]}'
else
 echo '{"labels":{"custom":"value"},"argv":["codex","--model","fixture"]}'
fi
`
	os.WriteFile(filepath.Join(bin, "hc"), []byte(script), 0700)
	out := hudPanes(context.Background())
	if out.Error != "" || !out.HC || len(out.Terminals) != 2 {
		t.Fatalf("panes: %+v", out)
	}
	if out.Terminals[0].Labels["custom"] != "value" || out.Terminals[1].Labels["hub.observer"] != "t1" {
		t.Fatalf("labels: %+v", out.Terminals)
	}
}

func TestHUDPanesTotalDeadline(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCH_HOME", "")
	bin := t.TempDir()
	t.Setenv("PATH", bin)
	os.WriteFile(filepath.Join(bin, "hc"), []byte("#!/bin/sh\nif [ \"$1\" = ls ]; then\necho '{\"terminals\":[{\"address\":\"t1\",\"agent\":\"codex\"}]}'\nelse\nexec /bin/sleep 10\nfi\n"), 0700)
	start := time.Now()
	_ = hudPanes(context.Background())
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("budget: %s", elapsed)
	}
}
