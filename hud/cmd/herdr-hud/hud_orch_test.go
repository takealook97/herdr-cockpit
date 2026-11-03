package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestHUDOrchAvailable(t *testing.T) {
	home, bin := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", bin)
	if hudOrchAvailable() {
		t.Fatal("unexpected availability")
	}
	raw, err := json.Marshal(HUDPanes{})
	var decoded map[string]any
	if err != nil || json.Unmarshal(raw, &decoded) != nil || decoded["orch"] != false {
		t.Fatalf("missing false field: %s", raw)
	}
	if err := os.MkdirAll(filepath.Join(home, ".orch", "runs"), 0755); err != nil {
		t.Fatal(err)
	}
	if !hudOrchAvailable() {
		t.Fatal("runs directory should enable integration")
	}
	if err := os.RemoveAll(filepath.Join(home, ".orch")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "orch"), []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatal(err)
	}
	if !hudOrchAvailable() {
		t.Fatal("binary should enable integration")
	}
}
