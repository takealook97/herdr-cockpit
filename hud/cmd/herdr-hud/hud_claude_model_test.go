package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHUDModelDisplay(t *testing.T) {
	for id, want := range map[string]string{
		"claude-opus-5-5": "opus-5.5", "claude-sonnet-5-5": "sonnet-5.5",
		"claude-haiku-5-5-20261001": "haiku-5.5", "claude-fable-5-1": "fable-5.1",
		"gpt-6.1-sol": "gpt-6.1-sol", "opus": "opus", "claude-opus-4-20250514": "opus-4",
	} {
		if got := hudModelDisplay(id); got != want {
			t.Errorf("%s: got %q, want %q", id, got, want)
		}
	}
}

func TestHUDClaudeTranscriptModel(t *testing.T) {
	home := t.TempDir()
	cwd := "/tmp/project_a.b 한"
	dir := filepath.Join(home, "projects", "-tmp-project-a-b--")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	write := func(name, content string, when time.Time) {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, when, when); err != nil {
			t.Fatal(err)
		}
	}
	writeHUDClaudeSession(t, home, 101, "new", cwd)
	writeHUDClaudeSession(t, home, 102, "old", cwd)
	now := time.Now()
	write("old.jsonl", "{\"model\":\"claude-haiku-5-5\"}\n", now.Add(-time.Hour))
	write("new.jsonl", "{\"model\":\"claude-sonnet-5-5\"}\n{\"message\":{\"model\":\"claude-opus-5-5\"}}\n{\"model\":\"claude-haiku", now)
	if got := hudClaudeTranscriptModel(home, 101); got != "claude-opus-5-5" {
		t.Fatalf("newest/last/truncated: %q", got)
	}
	if got := hudClaudeTranscriptModel(home, 102); got != "claude-haiku-5-5" {
		t.Fatalf("second session in same cwd: %q", got)
	}
	if got := hudClaudeTranscriptModel(home, 103); got != "" {
		t.Fatalf("missing session must not guess newest transcript: %q", got)
	}
	write("new.jsonl", "{\"model\":\"claude-too-old-1-0\"}\n"+strings.Repeat("x", 300*1024)+"\n{\"model\":\"claude-fable-5-1\"}\n", now)
	if got := hudClaudeTranscriptModel(home, 101); got != "claude-fable-5-1" {
		t.Fatalf("tail: %q", got)
	}
	write("new.jsonl", "{\"model\":\"claude-too-old-1-0\"}\n"+strings.Repeat("x", 300*1024), now)
	if got := hudClaudeTranscriptModel(home, 101); got != "" {
		t.Fatalf("must not read before tail: %q", got)
	}
	if got := hudClaudeTranscriptModel(home, 104); got != "" {
		t.Fatalf("missing: %q", got)
	}
	if got := hudClaudeTranscriptModel(home, 0); got != "" {
		t.Fatalf("empty cwd: %q", got)
	}
}

func TestHUDClaudeLiveOverride(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "projects", "-fixture")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "session.jsonl"), []byte("{\"message\":{\"model\":\"claude-opus-5-5\"}}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	writeHUDClaudeSession(t, home, 101, "session", "/fixture")
	bin := t.TempDir()
	scripts := map[string]string{
		"hc": "#!/bin/sh\nprintf '%s\\n' '{\"pid\":100,\"cwd\":\"/fixture\"}'\n",
		"ps": "#!/bin/sh\nif [ \"$1\" = \"-A\" ]; then\nprintf '%s\\n' '100 1 zsh' '101 100 claude'\nelse\nprintf '%s\\n' \"claude CLAUDE_CONFIG_DIR=$FIXTURE_HOME OTHER=value\"\nfi\n",
	}
	for name, script := range scripts {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin)
	t.Setenv("FIXTURE_HOME", home)
	out := HUDPanes{Terminals: []HUDTerminal{{Address: "t1", Program: "claude-code", Model: "sonnet"}}, Runs: []HUDRun{{Workers: []HUDWorker{{Terminal: "t1", Model: "opus", Effort: "high"}, {Terminal: "t2", Model: "catalog-fallback"}}}}}
	hudResolveClaudeModels(context.Background(), &out)
	if got := out.Terminals[0].Model; got != "opus-5.5" {
		t.Fatalf("terminal: %q", got)
	}
	if got := out.Runs[0].Workers[0]; got.Model != "opus-5.5" || got.Effort != "high" {
		t.Fatalf("worker: %+v", got)
	}
	if got := out.Runs[0].Workers[1].Model; got != "catalog-fallback" {
		t.Fatalf("other worker: %q", got)
	}
	hudApplyClaudeModel(&out, "t1", "")
	if out.Runs[0].Workers[0].Model != "opus-5.5" {
		t.Fatal("empty model replaced fallback")
	}

	// Only the first twelve Claude terminals are inspected.
	bounded := HUDPanes{}
	for i := 0; i < 13; i++ {
		bounded.Terminals = append(bounded.Terminals, HUDTerminal{Address: fmt.Sprintf("t%d", i), Program: "claude", Model: "sonnet"})
	}
	hudResolveClaudeModels(context.Background(), &bounded)
	for i, terminal := range bounded.Terminals {
		want := "opus-5.5"
		if i == 12 {
			want = "sonnet"
		}
		if terminal.Model != want {
			t.Fatalf("terminal %d: %q, want %q", i, terminal.Model, want)
		}
	}
	// Missing transcript keeps both argv and catalog values.
	t.Setenv("FIXTURE_HOME", t.TempDir())
	out.Terminals[0].Model = "sonnet"
	out.Runs[0].Workers[0].Model = "opus"
	hudResolveClaudeModels(context.Background(), &out)
	if out.Terminals[0].Model != "sonnet" || out.Runs[0].Workers[0].Model != "opus" {
		t.Fatal("missing transcript replaced fallback")
	}
}

func TestHUDClaudeResolutionDeadline(t *testing.T) {
	bin := t.TempDir()
	for name, script := range map[string]string{
		"ps": "#!/bin/sh\nprintf '%s\\n' '100 1 claude'\n",
		"hc": "#!/bin/sh\nexec /bin/sleep 10\n",
	} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin)
	out := HUDPanes{Terminals: []HUDTerminal{{Address: "t1", Program: "claude", Model: "opus"}}}
	start := time.Now()
	hudResolveClaudeModels(context.Background(), &out)
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("deadline exceeded: %v", elapsed)
	}
	if out.Terminals[0].Model != "opus" {
		t.Fatal("deadline replaced fallback")
	}
}

func writeHUDClaudeSession(t *testing.T, home string, pid int, id, cwd string) {
	t.Helper()
	dir := filepath.Join(home, "sessions")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(map[string]any{"pid": pid, "sessionId": id, "cwd": cwd})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("%d.json", pid)), raw, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestHUDClaudeTranscriptEffort(t *testing.T) {
	home := t.TempDir()
	cwd := "/tmp/effort"
	dir := filepath.Join(home, "projects", "-tmp-effort")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	writeHUDClaudeSession(t, home, 201, "s", cwd)
	lines := "{\"effort\":\"medium\"}\n{\"message\":{\"model\":\"claude-opus-5-5\"}}\n{\"perTurnEffort\":\"high\",\"effort\":\"high\"}\n{\"type\":\"user\"}\n"
	if err := os.WriteFile(filepath.Join(dir, "s.jsonl"), []byte(lines), 0600); err != nil {
		t.Fatal(err)
	}
	model, effort := hudClaudeTranscript(home, 201)
	if model != "claude-opus-5-5" || effort != "high" {
		t.Fatalf("got %q %q, want claude-opus-5-5 high", model, effort)
	}
	out := HUDPanes{Terminals: []HUDTerminal{{Address: "t1"}}}
	hudApplyClaudeEffort(&out, "t1", "high")
	if out.Terminals[0].Effort != "high" {
		t.Fatalf("terminal effort %q", out.Terminals[0].Effort)
	}
}

func TestHUDClaudeTranscriptPersistentCache(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	writeHUDClaudeSession(t, home, 301, "cached", "/fixture")
	dir := filepath.Join(home, "projects", "-fixture")
	os.MkdirAll(dir, 0700)
	path := filepath.Join(dir, "cached.jsonl")
	original := []byte("{\"model\":\"claude-opus-5-5\",\"effort\":\"high\"}\n")
	os.WriteFile(path, original, 0600)
	info, _ := os.Stat(path)
	model, effort := hudClaudeTranscript(home, 301)
	if model != "claude-opus-5-5" || effort != "high" {
		t.Fatalf("cold: %s %s", model, effort)
	}
	// Same identity, timestamp and size must use the persisted result, not reread.
	os.WriteFile(path, []byte(strings.Repeat("x", len(original))), 0600)
	os.Chtimes(path, info.ModTime(), info.ModTime())
	model, effort = hudClaudeTranscript(home, 301)
	if model != "claude-opus-5-5" || effort != "high" {
		t.Fatalf("warm: %s %s", model, effort)
	}
	os.WriteFile(path, []byte("{\"model\":\"claude-sonnet-5-5\",\"effort\":\"low\"}\n"), 0600)
	model, effort = hudClaudeTranscript(home, 301)
	if model != "claude-sonnet-5-5" || effort != "low" {
		t.Fatalf("invalidation: %s %s", model, effort)
	}
	raw, err := os.ReadFile(hudClaudeCachePath())
	if err != nil || !json.Valid(raw) {
		t.Fatalf("persistent cache: %s %v", raw, err)
	}
}

func TestHUDClaudeTranscriptCommands(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	home := t.TempDir()
	writeHUDClaudeSession(t, home, 401, "commands", "/fixture")
	dir := filepath.Join(home, "projects", "-fixture")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "commands.jsonl")
	assistant := `{"type":"assistant","message":{"model":"claude-opus-5"},"perTurnEffort":"medium"}` + "\n"
	cases := []struct{ name, lines, model, effort string }{
		{"new model", assistant + `{"type":"user","message":{"content":"<local-command-stdout>Set model to ` + "`Opus 5.5`" + ` and saved as your default for new sessions</local-command-stdout>"}}` + "\n", "opus-5.5", "medium"},
		{"older command", `{"type":"user","message":{"content":"<local-command-stdout>Set model to Sonnet 5.5</local-command-stdout>"}}` + "\n" + assistant, "claude-opus-5", "medium"},
		{"array and effort", assistant + `{"type":"user","message":{"content":[{"type":"text","text":"<local-command-stdout>Set model to Fable 5.1</local-command-stdout>"},{"type":"text","text":"<local-command-stdout>SET EFFORT LEVEL TO ` + "`XHIGH`" + `</local-command-stdout>"}]}}` + "\n", "fable-5.1", "xhigh"},
		{"default and effort", assistant + `{"type":"user","message":{"content":"<local-command-stdout>Set model to Default</local-command-stdout>"}}` + "\n" + `{"type":"user","message":{"content":"<local-command-stdout>Set effort to max</local-command-stdout>"}}` + "\n", "default", "max"},
		{"newer effort", `{"type":"user","message":{"content":"<local-command-stdout>Set effort to low</local-command-stdout>"}}` + "\n" + assistant, "claude-opus-5", "medium"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := os.WriteFile(path, []byte(tc.lines), 0600); err != nil {
				t.Fatal(err)
			}
			model, effort := hudClaudeTranscript(home, 401)
			if model != tc.model || effort != tc.effort {
				t.Fatalf("got %q %q, want %q %q", model, effort, tc.model, tc.effort)
			}
			model, effort = hudClaudeTranscript(home, 401)
			if model != tc.model || effort != tc.effort {
				t.Fatalf("cached got %q %q, want %q %q", model, effort, tc.model, tc.effort)
			}
		})
	}
}
