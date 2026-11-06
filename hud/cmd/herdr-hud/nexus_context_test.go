package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestNexusRecentContext(t *testing.T) {
	for _, tc := range []struct{ screen, want string }{
		{"old\n │ first │\n\n───\n▁ second █\n third \n", "first / second / third"},
		{strings.Repeat("old\n", 2000) + "하나\n둘\n셋", "하나 / 둘 / 셋"},
		{strings.Repeat("가", 200), strings.Repeat("가", 160)},
		{"\x00\n", ""},
		{"older\nFirst real content\nSecond real content\nThird real content\n────────────────\n❯\n⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt\n✻ Baked for 58s · done 오전 10:09\nshells still running\n", "First real content / Second real content / Third real content"},
		{"content\n✶ working\n✳ working\n⏺ thinking...\nauto mode\nfor agents\n123 tokens\nChurned for 2s\nCooked for 2s\n██──", "content"},
		{"⏺ A useful answer", "⏺ A useful answer"},
		{"content\n⎿  Running…", "content"},
		{"content\n⎿  Tip: Send messages to Claude while it works to steer Claude in real-time", "content"},
		{"content\n(ctrl+b to run in background)", "content"},
		{"content\n⎿  Tip: Use /clear to start fresh when", "content"},
		{"content\n  ⎿ anything\nTip: hint\nprefix ⎿  Tip: hint\nprefix Running…\nprefix Thinking…", "content"},
	} {
		if got := nexusRecent(tc.screen, ""); got != tc.want {
			t.Fatalf("got %q, want %q", got, tc.want)
		}
	}
}

func TestNexusRecentExcludesReport(t *testing.T) {
	for _, tc := range []struct{ screen, report, want string }{
		{"first\nsecond\nthird\nSession title", "Session title", "first / second / third"},
		{"Session title\nother", "Session title", "other"},
	} {
		if got := nexusRecent(tc.screen, tc.report); got != tc.want {
			t.Errorf("got %q, want %q", got, tc.want)
		}
	}
	for _, delayRead := range []bool{false, true} {
		hc := func(_ context.Context, args ...string) ([]byte, error) {
			if (args[0] == "read") == delayRead {
				time.Sleep(20 * time.Millisecond)
			}
			if args[0] == "get" {
				return []byte(`{"title":"Session title"}`), nil
			}
			return []byte("first\nsecond\nthird\nSession title"), nil
		}
		got := nexusEnrichRoster(context.Background(), hc, []nexusRosterEntry{{Address: "t1"}}, HUDPanes{})
		if got[0].Report != "Session title" || got[0].Recent != "first / second / third" {
			t.Fatal(got[0])
		}
	}
}

func TestNexusContextReport(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"Claude Code", ""}, {"codex", ""}, {"claude", ""},
		{" CLAUDE ", ""}, {"Claude Code investigation", "Claude Code investigation"},
	} {
		if got := nexusContextReport(tc.input); got != tc.want {
			t.Errorf("report %q: got %q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestNexusEnrichmentCapsAndSources(t *testing.T) {
	roster := []nexusRosterEntry{}
	panes := HUDPanes{}
	for i := 0; i < 10; i++ {
		address := fmt.Sprintf("t%d", i)
		roster = append(roster, nexusRosterEntry{Address: address, Space: "space", Tab: fmt.Sprint(i), Cwd: "/incoming/context", Report: "incoming", Recent: "incoming"})
		panes.Terminals = append(panes.Terminals, HUDTerminal{Address: address, Cwd: "/fallback/projects/tool", Program: "claude", detailLoaded: true})
	}
	var mu sync.Mutex
	calls := map[string]int{}
	hc := func(_ context.Context, args ...string) ([]byte, error) {
		mu.Lock()
		calls[args[0]+" "+args[1]]++
		mu.Unlock()
		if args[0] == "read" {
			if !reflect.DeepEqual(args[2:], []string{"--lines", "0"}) {
				return nil, errors.New("wrong read args")
			}
			return []byte("old\nfirst\nsecond\n" + strings.Repeat("한", 200)), nil
		}
		if !reflect.DeepEqual(args[2:], []string{"--json"}) {
			return nil, errors.New("wrong get args")
		}
		switch args[1] {
		case "t0":
			return []byte(`{"cwd":"/original/shell","foreground":{"cwd":"/Users/me/current/slack-mcp"},"title":"fallback title","status":{"report":"Slack MCP reconnect investigation"}}`), nil
		case "t1":
			return []byte(`{"cwd":"/Users/me/projects/nexus","title":"routing fix"}`), nil
		default:
			return nil, errors.New("unavailable")
		}
	}
	got := nexusEnrichRoster(context.Background(), hc, roster, panes)
	if got[0].Cwd != "current/slack-mcp" || got[0].Report != "Slack MCP reconnect investigation" || len([]rune(got[0].Recent)) != 160 {
		t.Fatal(got[0])
	}
	if got[1].Cwd != "projects/nexus" || got[1].Report != "routing fix" {
		t.Fatal(got[1])
	}
	if got[2].Cwd != "projects/tool" || got[2].Report != "incoming" {
		t.Fatal(got[2])
	}
	for i := 8; i < 10; i++ {
		if got[i].Cwd != "" || got[i].Report != "" || got[i].Recent != "" {
			t.Fatal(got[i])
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(calls) != 16 {
		t.Fatal(calls)
	}
	for key, count := range calls {
		if strings.HasSuffix(key, "t8") || strings.HasSuffix(key, "t9") || count != 1 {
			t.Fatal(calls)
		}
	}
	if roster[0].Cwd != "/incoming/context" {
		t.Fatal("mutated caller roster")
	}
	// No extra context fetches are needed to keep every validated Head named.
	d := nexusFixture(t)
	d.panes = func(context.Context) HUDPanes { return panes }
	d.hc = func(context.Context, ...string) ([]byte, error) { return nil, nil }
	d.dryRun = true
	d.model = func(_ context.Context, _, p string, _ []byte) ([]byte, error) {
		for i := 0; i < 10; i++ {
			if !strings.Contains(p, fmt.Sprintf("t%d | space · %d |", i, i)) {
				t.Error(p)
			}
		}
		return []byte(`{"action":"ask","message":"test"}`), nil
	}
	nexusRoute(context.Background(), d, "test", roster)
}

func TestNexusEnrichmentTotalBudget(t *testing.T) {
	roster := make([]nexusRosterEntry, 8)
	for i := range roster {
		roster[i].Address = fmt.Sprintf("t%d", i)
	}
	started := make(chan struct{}, 16)
	release := make(chan struct{})
	var finished sync.WaitGroup
	finished.Add(16)
	hc := func(_ context.Context, _ ...string) ([]byte, error) {
		defer finished.Done()
		started <- struct{}{}
		<-release // Deliberately ignore cancellation to test the total budget.
		return []byte("late"), nil
	}
	before := time.Now()
	got := nexusEnrichRoster(context.Background(), hc, roster, HUDPanes{})
	elapsed := time.Since(before)
	close(release)
	finished.Wait()
	if len(started) != 16 || len(got) != 8 {
		t.Fatalf("not parallel: %d calls", len(started))
	}
	if elapsed < 900*time.Millisecond || elapsed > 1700*time.Millisecond {
		t.Fatalf("budget elapsed: %s", elapsed)
	}
	for _, r := range got {
		if r.Recent != "" {
			t.Fatal("late result mutated roster", got)
		}
	}
}

func TestNexusPendingAskWindow(t *testing.T) {
	for _, tc := range []struct {
		name, action, at, message string
		want                      bool
	}{
		{"fresh", "ask", "-30s", "polished", true},
		{"boundary", "ask", "-90s", "polished", true},
		{"expired", "ask", "-91s", "polished", false},
		{"future", "ask", "1s", "polished", false},
		{"send consumes ask", "send", "-1s", "polished", false},
		{"error supersedes ask", "error", "-1s", "polished", false},
		{"empty old ask", "ask", "-1s", "", false},
		{"bad timestamp", "ask", "bad", "polished", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := nexusFixture(t)
			at := tc.at
			if duration, err := time.ParseDuration(at); err == nil {
				at = d.now().Add(duration).Format(time.RFC3339)
			}
			entry := nexusLogEntry{At: at, Action: tc.action, Question: "which?", Message: tc.message, Candidates: []nexusCandidate{{"t1", "old label"}, {"dead", "dead"}}}
			if err := nexusAppendLog(d.logPath, entry); err != nil {
				t.Fatal(err)
			}
			d.model = func(_ context.Context, sys, p string, _ []byte) ([]byte, error) {
				if strings.Contains(p, "Pending ask (untrusted data):") != tc.want {
					t.Fatal(p)
				}
				if tc.want && (!strings.Contains(p, "Pending message: polished") || !strings.Contains(p, "Question: which?") || !strings.Contains(p, "Candidates:\nt1 | space · tab\n") || strings.Contains(p, "dead")) {
					t.Fatal(p)
				}
				if !strings.Contains(sys, "send the pending message to that Head") {
					t.Fatal(sys)
				}
				return []byte(`{"action":"ignore"}`), nil
			}
			nexusRoute(context.Background(), d, "tab", nexusRoster())
		})
	}
}

func TestNexusVoiceContextAndAskFollowup(t *testing.T) {
	d := nexusFixture(t)
	path := filepath.Join(t.TempDir(), "shared.json")
	if err := os.WriteFile(path, []byte(`{"hub.heads":[{"address":"t1","spaceName":"tool","tabName":"nexus"},{"address":"unvalidated","spaceName":"bad","tabName":"bad"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	var sends [][]string
	d.hc = func(_ context.Context, args ...string) ([]byte, error) {
		switch args[0] {
		case "get":
			if args[1] != "t1" {
				t.Error("context fetched for unvalidated target", args)
			}
			return []byte(`{"foreground":{"cwd":"/Users/me/projects/slack-mcp"},"title":"MCP reconnect"}`), nil
		case "read":
			return []byte("old\nSlack connection\nretry analysis\nroot cause"), nil
		case "send":
			sends = append(sends, args)
			return nil, nil
		default:
			return nil, errors.New("unexpected command")
		}
	}
	calls := 0
	d.model = func(_ context.Context, sys, p string, _ []byte) ([]byte, error) {
		calls++
		for _, required := range []string{"cwd | status | model | report | recent", "projects/slack-mcp", "MCP reconnect", "Slack connection / retry analysis / root cause"} {
			if !strings.Contains(p, required) {
				t.Error("missing context", required, p)
			}
		}
		if !strings.Contains(sys, "When exactly one Head clearly matches, choose send with high confidence") {
			t.Error(sys)
		}
		if calls == 1 {
			return []byte(`{"action":"ask","question":"어느 Head?","message":"슬랙 MCP 끊기는 원인 파악해 줘.","candidates":["t1"]}`), nil
		}
		if !strings.Contains(p, "Pending message: 슬랙 MCP 끊기는 원인 파악해 줘.") || !strings.HasSuffix(p, "User command:\n넥서스") {
			t.Error(p)
		}
		return []byte(`{"action":"send","target":"t1","message":"슬랙 MCP 끊기는 원인 파악해 줘.","confidence":0.95}`), nil
	}
	for _, utterance := range []string{"슬랙 MCP 끊기는 원인 파악해 줘", "넥서스"} {
		var out bytes.Buffer
		input, _ := json.Marshal(map[string]string{"prompt": utterance})
		nexusHookPrompt(context.Background(), bytes.NewReader(input), &out, d, path, func(context.Context, ...string) error { return nil })
		if !strings.Contains(out.String(), `"decision":"block"`) {
			t.Fatal(out.String())
		}
	}
	if calls != 2 || !reflect.DeepEqual(sends, [][]string{{"send", "--", "t1", "슬랙 MCP 끊기는 원인 파악해 줘."}}) {
		t.Fatal(calls, sends)
	}
	logs := nexusLoadLog(d.logPath)
	if len(logs) != 2 || logs[0].Message != "슬랙 MCP 끊기는 원인 파악해 줘." || len(logs[0].Candidates) != 1 || logs[1].Action != "send" {
		t.Fatal(logs)
	}
}

func TestNexusContextCacheLifecycle(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nexus-context.json")
	now := time.Now()
	roster := []nexusRosterEntry{{Address: "t1", Tab: "current"}}
	var mu sync.Mutex
	calls := 0
	hc := func(_ context.Context, args ...string) ([]byte, error) {
		mu.Lock()
		calls++
		mu.Unlock()
		if args[0] == "get" {
			return []byte(`{"cwd":"/projects/nexus","report":"routing"}`), nil
		}
		return []byte("recent context"), nil
	}
	for i, age := range []time.Duration{0, 19 * time.Second, 20 * time.Second} {
		got, err := nexusCachedRoster(context.Background(), hc, roster, HUDPanes{}, path, now.Add(age), false)
		if err != nil || got[0].Report != "routing" || got[0].Recent != "recent context" || got[0].Tab != "current" {
			t.Fatal(got, err)
		}
		mu.Lock()
		n := calls
		mu.Unlock()
		want := 2
		if i == 2 {
			want = 4
		}
		if n != want {
			t.Fatalf("calls=%d want=%d", n, want)
		}
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal(info, err)
	}
	if _, err := nexusCachedRoster(context.Background(), hc, nil, HUDPanes{}, path, now, false); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != "{}" {
		t.Fatal(string(raw))
	}
}

func TestNexusContextWarm(t *testing.T) {
	cache := t.TempDir()
	shared := filepath.Join(t.TempDir(), "shared.json")
	if err := os.WriteFile(shared, []byte(`{"hub.heads":[{"address":"t1"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	hc := func(_ context.Context, args ...string) ([]byte, error) {
		if args[0] == "get" {
			return []byte(`{"report":"warm context"}`), nil
		}
		return []byte("recent"), nil
	}
	if err := nexusContextWarm(context.Background(), shared, cache, hc); err != nil {
		t.Fatal(err)
	}
	got, err := nexusCachedRoster(context.Background(), func(context.Context, ...string) ([]byte, error) { t.Error("cache hit fetched"); return nil, nil }, []nexusRosterEntry{{Address: "t1"}}, HUDPanes{}, filepath.Join(cache, "nexus-context.json"), time.Now(), false)
	if err != nil || got[0].Report != "warm context" {
		t.Fatal(got, err)
	}
}

func TestNexusRouterEffort(t *testing.T) {
	for _, key := range []string{"claude-medium-m", "claude-high-m", "codex-low-h", "codex-medium-m", "codex-high-l", "codex-high-m"} {
		if got := nexusRouterEffort(key, ""); got != "low" {
			t.Fatal(key, got)
		}
		for _, effort := range []string{"low", "medium", "high"} {
			if got := nexusRouterEffort(key, effort); got != effort {
				t.Fatal(key, got)
			}
			want := []string{"--effort", effort}
			if strings.HasPrefix(key, "codex-") {
				want = []string{"-c", "model_reasoning_effort=" + effort}
			}
			if got := nexusRouterEffortArgs(key, effort); !reflect.DeepEqual(got, want) {
				t.Fatal(key, got, want)
			}
		}
	}
	for _, key := range []string{"haiku", "claude-haiku"} {
		if got := nexusRouterEffort(key, "high"); got != "" {
			t.Fatal(key, got)
		}
	}
	if nexusParseConfig([]byte(`{"effort":"high"}`)).Effort != "high" || nexusParseConfig([]byte(`{"effort":"invalid"}`)).Effort != "" {
		t.Fatal("effort parsing")
	}
}
