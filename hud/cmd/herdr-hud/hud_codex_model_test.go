package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func codexWrite(t *testing.T, path, data string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
}
func codexContext(model, effort string) string {
	raw, _ := json.Marshal(map[string]any{"type": "turn_context", "payload": map[string]string{"model": model, "effort": effort}})
	return string(raw) + "\n"
}
func codexTools(t *testing.T, ps, lsof string) string {
	t.Helper()
	bin := t.TempDir()
	for name, body := range map[string]string{"ps": ps, "lsof": lsof} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"+body), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin)
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	return bin
}

func TestHUDCodexNativePID(t *testing.T) {
	procs := hudParseProcesses("100 1 zsh\n101 100 node\n102 101 /vendor/codex\n103 102 zsh\n104 103 codex\n200 1 zsh\n201 200 codex\n300 1 zsh\n301 300 claude\n302 301 codex\n400 1 node\n401 400 zsh\n402 401 codex\n500 1 codex\n501 500 codex\n600 1 node\n601 600 codex\n602 600 codex")
	args := map[int]string{101: "node --no-warnings /npm/@openai/codex/bin/codex.js", 400: "node /npm/bin/codex", 600: "node /npm/bin/codex"}
	for root, want := range map[int]int{100: 102, 101: 102, 102: 102, 200: 201, 300: 0, 400: 0, 500: 500, 600: 0, 999: 0} {
		if got := hudCodexNativePID(root, procs, args); got != want {
			t.Errorf("root %d: got %d want %d", root, got, want)
		}
	}
	for _, tc := range []struct {
		name, processes string
		args            map[int]string
		want            int
	}{
		{"native siblings", "10 1 zsh\n11 10 codex\n12 10 codex", nil, 0},
		{"wrapper siblings", "10 1 zsh\n11 10 node\n12 10 node\n13 11 codex\n14 12 codex", map[int]string{11: "node /npm/bin/codex", 12: "node /npm/bin/codex"}, 0},
		{"codex and claude siblings", "10 1 zsh\n11 10 codex\n12 10 claude", nil, 0},
		{"unrelated node sibling", "10 1 zsh\n11 10 codex\n12 10 node", map[int]string{12: "node /app/server.js"}, 11},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := hudCodexNativePID(10, hudParseProcesses(tc.processes), tc.args); got != tc.want {
				t.Errorf("got %d want %d", got, tc.want)
			}
		})
	}

}

func TestHUDCodexRollouts(t *testing.T) {
	raw := "n/tmp/rollout-unbound.jsonl\np101\nn/tmp/account/sessions/rollout-a.jsonl\nn/tmp/account/sessions/rollout-a.jsonl\nn/tmp/not-rollout.jsonl\np102\nn/tmp/rollout-b.jsonl\nn/tmp/rollout-c.jsonl\np103\nnrelative/rollout-d.jsonl\nn/tmp/rollout-no.jsonl (deleted)\npbad\nn/tmp/rollout-e.jsonl\n"
	got := hudCodexRollouts(raw)
	if len(got) != 2 || len(got[101]) != 1 || len(got[102]) != 2 {
		t.Fatalf("paths: %#v", got)
	}
}

func TestHUDCodexTurnContext(t *testing.T) {
	for _, id := range []string{"gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "future-exact-ID"} {
		raw := codexContext("old", "low") + codexContext(id, "xhigh") +
			`{"type":"response_item","payload":{"model":"wrong","effort":"wrong","content":"ignored"}}` + "\n" +
			`{"type":"event_msg","payload":{"model":"wrong","effort":"wrong"}}` + "\n" +
			`{"type":"turn_context","payload":{"model":false}}` + "\n" +
			`{"type":"turn_context","payload":{"model":"truncated"}}` // valid JSON, incomplete JSONL
		model, effort := hudCodexTurnContext([]byte(raw), false)
		if model != id || effort != "xhigh" {
			t.Fatalf("%s: %q %q", id, model, effort)
		}
	}
	raw := codexContext("prefix", "high") + `{"type":"turn_context","payload":{"model":"fallback","reasoning_effort":"medium"}}` + "\n{bad}\n"
	if m, e := hudCodexTurnContext([]byte(raw), true); m != "fallback" || e != "medium" {
		t.Fatalf("prefix/fallback: %s %s", m, e)
	}
	if m, e := hudCodexTurnContext([]byte(codexContext("prefix", "high")), true); m != "" || e != "" {
		t.Fatal("partial prefix trusted")
	}
}

func TestHUDCodexLiveAssociation(t *testing.T) {
	dir := t.TempDir() // both sessions share account and cwd; only lsof associates them
	a, b := filepath.Join(dir, "rollout-a.jsonl"), filepath.Join(dir, "rollout-b.jsonl")
	codexWrite(t, a, codexContext("gpt-6-astra", "high"))
	codexWrite(t, b, codexContext("gpt-6-luna", "low"))
	codexTools(t, `if [ "$1" = "-A" ]; then
printf '%s\n' '100 1 zsh' '101 100 node' '102 101 codex' '103 102 codex' '200 1 zsh' '201 200 codex'
else
printf '%s\n' '101 node /npm/@openai/codex/bin/codex.js'
fi
`, `test "$1" = '-nP' && test "$2" = '-a' && test "$3" = '-p' && test "$4" = '102,201' && test "$5" = '-Fpn' || exit 2
printf 'p102\nn%s\nn%s\np201\nn%s\np103\nn/never/rollout-nested.jsonl\n' "$ROLLOUT_A" "$ROLLOUT_A" "$ROLLOUT_B"
`)
	t.Setenv("ROLLOUT_A", a)
	t.Setenv("ROLLOUT_B", b)
	out := HUDPanes{Terminals: []HUDTerminal{
		{Address: "a", Program: "codex", Model: "launch", Effort: "medium", pid: 100},
		{Address: "b", Program: "/bin/codex", Model: "launch", pid: 200},
		{Address: "remote/a", Program: "codex", Model: "remote", pid: 100},
		{Address: "observer", Program: "codex", Model: "observer", pid: 100, Labels: map[string]string{"hub.observer": "1"}},
		{Address: "claude", Program: "claude", Model: "claude", pid: 100},
	}, Runs: []HUDRun{{Workers: []HUDWorker{{Terminal: "a", Model: "catalog", Effort: "medium"}, {Terminal: "b", Model: "catalog"}, {Terminal: "other", Model: "unchanged"}}}}}
	hudResolveCodexModels(context.Background(), &out)
	if out.Terminals[0].Model != "gpt-6-astra" || out.Terminals[0].Effort != "high" || out.Terminals[1].Model != "gpt-6-luna" {
		t.Fatalf("terminals: %+v", out.Terminals)
	}
	for i, want := range []string{"remote", "observer", "claude"} {
		if out.Terminals[i+2].Model != want {
			t.Fatal("changed unrelated terminal")
		}
	}
	if ws := out.Runs[0].Workers; ws[0].Model != "gpt-6-astra" || ws[0].Effort != "high" || ws[1].Model != "gpt-6-luna" || ws[2].Model != "unchanged" {
		t.Fatalf("workers: %+v", ws)
	}
	codexWrite(t, a, codexContext("gpt-6.1-sol", "medium"))
	hudResolveCodexModels(context.Background(), &out)
	if out.Terminals[0].Model != "gpt-6.1-sol" || out.Runs[0].Workers[0].Effort != "medium" {
		t.Fatal("later model switch not applied")
	}
}

func TestHUDCodexFallbacksAndBound(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout-fixture.jsonl")
	codexWrite(t, path, codexContext("gpt-6-astra", "high"))
	bin := codexTools(t, "printf '%s\\n' '101 1 codex'\n", "printf 'p101\\nn%s\\n' \"$ROLLOUT_A\"\n")
	t.Setenv("ROLLOUT_A", path)
	out := HUDPanes{}
	for i := 0; i < 13; i++ {
		out.Terminals = append(out.Terminals, HUDTerminal{Address: fmt.Sprintf("t%d", i), Program: "codex", Model: "launch", pid: 101})
	}
	hudResolveCodexModels(context.Background(), &out)
	for i, v := range out.Terminals {
		want := "gpt-6-astra"
		if i == 12 {
			want = "launch"
		}
		if v.Model != want {
			t.Fatalf("limit %d: %s", i, v.Model)
		}
	}
	for _, body := range []string{"exit 1\n", "printf 'p101\\nn/tmp/no.jsonl\\n'\n", "printf 'p101\\nn%s\\nn/tmp/rollout-other.jsonl\\n' \"$ROLLOUT_A\"\n"} {
		if err := os.WriteFile(filepath.Join(bin, "lsof"), []byte("#!/bin/sh\n"+body), 0700); err != nil {
			t.Fatal(err)
		}
		out.Terminals[0].Model = "launch"
		hudResolveCodexModels(context.Background(), &out)
		if out.Terminals[0].Model != "launch" {
			t.Fatal("guessed missing/ambiguous session")
		}
	}
	if err := os.Remove(filepath.Join(bin, "lsof")); err != nil {
		t.Fatal(err)
	}
	hudResolveCodexModels(context.Background(), &out)
	if out.Terminals[0].Model != "launch" {
		t.Fatal("missing lsof replaced fallback")
	}
	if err := os.Remove(filepath.Join(bin, "ps")); err != nil {
		t.Fatal(err)
	}
	hudResolveCodexModels(context.Background(), &out)
	if out.Terminals[0].Model != "launch" {
		t.Fatal("missing ps replaced fallback")
	}
}

func TestHUDCodexCache(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	path := filepath.Join(t.TempDir(), "rollout-cache.jsonl")
	ctx := context.Background()
	original := codexContext("gpt-6-astra", "high") + strings.Repeat("x", 700*1024) + "\n"
	codexWrite(t, path, original)
	info, _ := os.Stat(path)
	check := func(pid int, path, model, effort string) {
		t.Helper()
		m, e := hudCodexTranscript(ctx, pid, path)
		if m != model || e != effort {
			t.Fatalf("got %q %q want %q %q", m, e, model, effort)
		}
	}
	check(101, path, "gpt-6-astra", "high") // first read metadata >512 KiB from EOF
	codexWrite(t, path, strings.Repeat("x", len(original)))
	if err := os.Chtimes(path, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	check(101, path, "gpt-6-astra", "high") // unchanged stat: persisted cache, no reread
	codexWrite(t, path, strings.Repeat("x", hudCodexTailLimit+100)+"\n")
	check(101, path, "gpt-6-astra", "high") // growth without context retains verified metadata
	check(102, path, "", "")                // never share across PIDs
	codexWrite(t, path, "{bad}\n")
	check(101, path, "", "") // truncation clears
	codexWrite(t, path, codexContext("future-model", "max"))
	check(101, path, "future-model", "max")
	other := filepath.Join(t.TempDir(), "rollout-other.jsonl")
	codexWrite(t, other, "{bad}\n")
	check(101, other, "", "")
	// Returning to the old path must not resurrect the previous association.
	oldInfo, _ := os.Stat(path)
	codexWrite(t, path, strings.Repeat("x", int(oldInfo.Size())))
	os.Chtimes(path, oldInfo.ModTime(), oldInfo.ModTime())
	check(101, path, "", "")
	codexWrite(t, path, codexContext("gpt-6-luna", "low"))
	check(101, path, "gpt-6-luna", "low")
	// Replacement inode with the same length/time is not the same session file.
	oldInfo, _ = os.Stat(path)
	replacement := filepath.Join(filepath.Dir(path), "replacement")
	codexWrite(t, replacement, strings.Repeat("x", int(oldInfo.Size())))
	os.Chtimes(replacement, oldInfo.ModTime(), oldInfo.ModTime())
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	check(101, path, "", "")
	raw, err := os.ReadFile(hudCodexCachePath())
	if err != nil || !json.Valid(raw) || strings.Contains(string(raw), "payload") {
		t.Fatalf("metadata cache: %s %v", raw, err)
	}
}

func TestHUDCodexTailAndCacheBound(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	path := filepath.Join(t.TempDir(), "rollout-tail.jsonl")
	codexWrite(t, path, codexContext("too-old", "low")+strings.Repeat("x", hudCodexTailLimit)+"\n")
	if m, _ := hudCodexTranscript(context.Background(), 1, path); m != "" {
		t.Fatal("read beyond limit")
	}
	cache := map[string]hudCodexCacheEntry{}
	for i := 0; i < 256; i++ {
		cache[fmt.Sprintf("%d:old", i+10)] = hudCodexCacheEntry{PID: i + 10, Path: "old"}
	}
	hudWriteCodexCache(cache)
	codexWrite(t, path, codexContext("gpt-6-astra", "high"))
	hudCodexTranscript(context.Background(), 1, path)
	raw, err := os.ReadFile(hudCodexCachePath())
	if err != nil {
		t.Fatal(err)
	}
	var persisted map[string]hudCodexCacheEntry
	if err := json.Unmarshal(raw, &persisted); err != nil || len(persisted) > 256 {
		t.Fatalf("cache bound: %d %v", len(persisted), err)
	}
}

func TestHUDCodexDeadline(t *testing.T) {
	codexTools(t, "printf '%s\\n' '101 1 codex'\n", "exec /bin/sleep 10\n")
	out := HUDPanes{Terminals: []HUDTerminal{{Address: "t1", Program: "codex", Model: "launch", pid: 101}}}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	hudResolveCodexModels(ctx, &out)
	if time.Since(start) > time.Second || out.Terminals[0].Model != "launch" {
		t.Fatal("deadline/fallback")
	}
}

func TestHUDCodexPartialContextChanges(t *testing.T) {
	raw := codexContext("current", "high") + codexContext("", "low")
	if m, e := hudCodexTurnContext([]byte(raw), false); m != "current" || e != "low" {
		t.Fatalf("effort-only switch: %q %q", m, e)
	}
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	path := filepath.Join(t.TempDir(), "rollout-partial.jsonl")
	codexWrite(t, path, raw)
	hudCodexTranscript(context.Background(), 1, path)
	codexWrite(t, path, raw+strings.Repeat("x", hudCodexTailLimit)+"\n"+codexContext("new", ""))
	if m, e := hudCodexTranscript(context.Background(), 1, path); m != "new" || e != "low" {
		t.Fatalf("model-only switch outside previous tail: %q %q", m, e)
	}
}

func TestHUDCodexSettingsOrdering(t *testing.T) {
	settings := func(fields string) string {
		return `{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":` + fields + `}}` + "\n"
	}
	for _, tc := range []struct{ name, raw, model, effort string }{
		{"effort change", codexContext("astra", "xhigh") + settings(`{"model":"astra","reasoning_effort":"medium"}`), "astra", "medium"},
		{"model change", codexContext("astra", "high") + settings(`{"model":"sol"}`), "sol", "high"},
		{"effort only", codexContext("astra", "high") + settings(`{"reasoning_effort":"medium"}`), "astra", "medium"},
		{"reverse", settings(`{"model":"sol","reasoning_effort":"medium"}`) + codexContext("astra", "xhigh"), "astra", "xhigh"},
		{"cleared effort", codexContext("astra", "high") + settings(`{"reasoning_effort":null}`), "astra", ""},
		{"cleared model", codexContext("astra", "high") + settings(`{"model":""}`), "", "high"},
		{"unfinished settings", codexContext("astra", "high") + strings.TrimSuffix(settings(`{"model":"sol"}`), "\n"), "astra", "high"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, e := hudCodexTurnContext([]byte(tc.raw), false)
			if m != tc.model || e != tc.effort {
				t.Fatalf("got %q %q want %q %q", m, e, tc.model, tc.effort)
			}
		})
	}
}

func TestHUDCodexSettingsCacheVersion(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	raw := codexContext("astra", "xhigh") + `{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"reasoning_effort":"medium"}}}` + "\n"
	codexWrite(t, path, raw)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	entry := hudCodexCacheEntry{PID: 42, Path: path, Mtime: info.ModTime().UnixNano(), Size: info.Size(), Model: "astra", Effort: "xhigh"}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		entry.Device, entry.Inode = uint64(stat.Dev), uint64(stat.Ino)
	}
	hudWriteCodexCache(map[string]hudCodexCacheEntry{fmt.Sprintf("%d:%s", 42, path): entry})
	if m, e := hudCodexTranscript(context.Background(), 42, path); m != "astra" || e != "medium" {
		t.Fatalf("stale cache: %q %q", m, e)
	}
	// Explicit clears must also replace a retained value when older metadata falls outside the tail.
	codexWrite(t, path, raw+strings.Repeat("x", hudCodexTailLimit)+"\n"+`{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"reasoning_effort":null}}}`+"\n")
	if m, e := hudCodexTranscript(context.Background(), 42, path); m != "astra" || e != "" {
		t.Fatalf("cached clear: %q %q", m, e)
	}
}
