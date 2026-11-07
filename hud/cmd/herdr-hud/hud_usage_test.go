package main

import "testing"

func TestHUDFindAgentExecutablePaths(t *testing.T) {
	for _, tc := range []struct {
		name, comm, args, provider string
	}{
		{"claude", "/usr/local/bin/claude", "", "claude"},
		{"native version", "/fixture/.local/share/claude/versions/2.1.319", "", "claude"},
		{"custom data home", "/data/claude/versions/2.1.319", "", "claude"},
		{"version suffix", "/data/claude/versions/2.1.319-beta", "", "claude"},
		{"nested binary", "/data/claude/versions/2.1.319/native", "", "claude"},
		{"unrelated version", "/tmp/2.1.319", "", ""},
		{"bare version", "2.1.319", "", ""},
		{"wrong installer", "/data/other/versions/2.1.319", "", ""},
		{"invalid version", "/data/claude/versions/latest/native", "", ""},
		{"codex", "/usr/local/bin/codex", "", "codex"},
		{"node claude", "/usr/bin/node", "node /tools/claude/cli.js", "claude"},
		{"node codex", "/usr/bin/node", "node /tools/codex", "codex"},
		{"unrelated node", "/usr/bin/node", "node /tools/server.js", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			procs := []hudProcess{{PID: 100, PPID: 1, Comm: "/bin/zsh"}, {PID: 101, PPID: 100, Comm: tc.comm}}
			pid, provider := hudFindAgent(100, procs, func(int) string { return tc.args })
			wantPID := 101
			if tc.provider == "" {
				wantPID = 0
			}
			if pid != wantPID || provider != tc.provider {
				t.Fatalf("got %d %q, want %d %q", pid, provider, wantPID, tc.provider)
			}
		})
	}
}
