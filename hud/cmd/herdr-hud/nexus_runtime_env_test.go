package main

import (
	"context"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestNexusModelCommandEnvironment(t *testing.T) {
	runtimeKeys := []string{
		"CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID",
		"CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
		"CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH",
		"CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_PID",
	}
	removed := make(map[string]bool)
	for _, key := range runtimeKeys {
		t.Setenv(key, "synthetic-session")
		removed[key] = true
	}
	for _, key := range []string{
		"PATH", "HOME", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
		"CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_FUTURE_OPTION",
		"HC_TERMINAL_ID", "HERDR_ENV",
	} {
		t.Setenv(key, "synthetic-preserved=value")
	}
	var wantEnv []string
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !removed[key] {
			wantEnv = append(wantEnv, entry)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	args := []string{"-p", "--setting-sources", "", "--model", "haiku", "synthetic prompt"}
	cmd := nexusModelCommand(ctx, "claude", "/synthetic/claude", args...)
	if !reflect.DeepEqual(cmd.Env, wantEnv) {
		t.Fatal("Claude command must remove only the nine runtime keys and preserve all other environment entries")
	}
	if !reflect.DeepEqual(cmd.Args, append([]string{"/synthetic/claude"}, args...)) || cmd.Path != "/synthetic/claude" {
		t.Fatal("command path or arguments changed")
	}
	if cmd.Stdin != nil || cmd.WaitDelay != 2*time.Second || cmd.Cancel == nil {
		t.Fatal("stdin or context/pipe lifetime behavior changed")
	}
	for _, name := range []string{"codex", "hc", "other"} {
		if got := nexusModelCommand(ctx, name, "/synthetic/"+name); got.Env != nil {
			t.Fatalf("%s must keep inherited environment", name)
		}
	}
	if got := nexusCommand(ctx, "/synthetic/claude"); got.Env != nil {
		t.Fatal("generic command helper must keep inherited environment even for a Claude-named path")
	}
}
