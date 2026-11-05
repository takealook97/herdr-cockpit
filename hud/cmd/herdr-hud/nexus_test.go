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
	"testing"
	"time"
)

func nexusFixture(t *testing.T) nexusDeps {
	t.Helper()
	return nexusDeps{model: func(context.Context, string, string, []byte) ([]byte, error) {
		return []byte(`{"action":"send","target":"t1","message":"do it","confidence":0.9}`), nil
	}, hc: func(context.Context, ...string) ([]byte, error) { return nil, nil }, panes: func(context.Context) HUDPanes {
		return HUDPanes{Terminals: []HUDTerminal{{Address: "t1", detailLoaded: true, Program: "claude"}}}
	}, now: func() time.Time { return time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC) }, logPath: filepath.Join(t.TempDir(), "log.json")}
}
func nexusRoster() []nexusRosterEntry {
	return []nexusRosterEntry{{Address: "t1", Space: "space", Tab: "tab"}}
}
func TestNexusRoster(t *testing.T) {
	panes := HUDPanes{Terminals: []HUDTerminal{{Address: "t1", detailLoaded: true, Program: "claude"}, {Address: "t2", detailLoaded: true, Program: "codex"}, {Address: "t3", detailLoaded: true, Program: "claude", Labels: map[string]string{"hub.observer": ""}}, {Address: "remote/t4", detailLoaded: true, Program: "claude"}, {Address: "t6", Program: "zsh"}}, Runs: []HUDRun{{Workers: []HUDWorker{{Terminal: "t2"}}}}}
	for _, tc := range []struct {
		addr string
		want int
	}{{"t1", 1}, {"t2", 0}, {"t3", 0}, {"remote/t4", 0}, {"t5", 0}, {"t6", 0}} {
		t.Run(tc.addr, func(t *testing.T) {
			if got := nexusValidRoster([]nexusRosterEntry{{Address: tc.addr}}, panes); len(got) != tc.want {
				t.Fatalf("%+v", got)
			}
		})
	}
}
func TestNexusRoute(t *testing.T) {
	for _, tc := range []struct {
		name, raw, action string
		err               error
		sent              bool
	}{{"send", `{"action":"send","target":"t1","message":"-do it","confidence":0.9}`, "send", nil, true}, {"low", `{"action":"send","target":"t1","message":"x","confidence":0.4}`, "ask", nil, false}, {"unknown", `{"action":"send","target":"bad","message":"x","confidence":0.9}`, "ask", nil, false}, {"model error", "", "error", errors.New("model failed"), false}, {"invalid", "{", "error", nil, false}, {"timeout", "", "error", context.DeadlineExceeded, false}, {"invalid action", `{"action":"delete"}`, "error", nil, false}} {
		t.Run(tc.name, func(t *testing.T) {
			d := nexusFixture(t)
			d.model = func(context.Context, string, string, []byte) ([]byte, error) { return []byte(tc.raw), tc.err }
			var calls [][]string
			d.hc = func(_ context.Context, args ...string) ([]byte, error) { calls = append(calls, args); return nil, nil }
			r := nexusRoute(context.Background(), d, "command", nexusRoster())
			if r.Action != tc.action || r.Sent != tc.sent {
				t.Fatalf("%+v", r)
			}
			if tc.sent {
				if r.Label != "space · tab" || !reflect.DeepEqual(calls, [][]string{{"send", "--", "t1", "-do it"}}) {
					t.Fatalf("%+v %v", r, calls)
				}
			} else if len(calls) != 0 {
				t.Fatal(calls)
			}
			if tc.name == "low" && r.Message != "x" {
				t.Fatal("ask lost proposed instruction", r)
			}
			if r.Action == "ask" && len(r.Candidates) == 0 {
				t.Fatal("missing candidates")
			}
			if len(nexusLoadLog(d.logPath)) != 1 {
				t.Fatal("missing log")
			}
		})
	}
}
func TestNexusStatusForwarded(t *testing.T) {
	d := nexusFixture(t)
	calls := 0
	d.model = func(_ context.Context, sys, p string, schema []byte) ([]byte, error) {
		calls++
		if strings.Contains(string(schema), `"read"`) || !strings.Contains(sys, "polish the dictated message once") || !strings.Contains(sys, "pronunciation") {
			t.Fatal(sys, string(schema))
		}
		return []byte(`{"action":"send","target":"t1","message":"어디까지 했어?","confidence":0.9}`), nil
	}
	d.hc = func(_ context.Context, args ...string) ([]byte, error) {
		if !reflect.DeepEqual(args, []string{"send", "--", "t1", "어디까지 했어?"}) {
			t.Fatal(args)
		}
		return nil, nil
	}
	r := nexusRoute(context.Background(), d, "wiki-island 어디까지 했어?", nexusRoster())
	if r.Action != "send" || !r.Sent || calls != 1 {
		t.Fatal(r, calls)
	}
}
func TestNexusSend(t *testing.T) {
	for _, tc := range []struct {
		name, to, text string
		hcErr          error
		action         string
	}{{"valid", "t1", "-hello", nil, "send"}, {"invalid", "t9", "hi", nil, "error"}, {"empty", "t1", "\x00", nil, "error"}, {"hc failure", "t1", "hello", errors.New(strings.Repeat("가", 500)), "error"}} {
		t.Run(tc.name, func(t *testing.T) {
			d := nexusFixture(t)
			count := 0
			d.hc = func(_ context.Context, args ...string) ([]byte, error) { count++; return nil, tc.hcErr }
			r := nexusSend(context.Background(), d, tc.to, tc.text, nexusRoster())
			if r.Action != tc.action || len([]rune(r.Error)) > 300 {
				t.Fatalf("%+v", r)
			}
			if (tc.to == "t9" || tc.name == "empty") && count != 0 {
				t.Fatal(count)
			}
			if len(nexusLoadLog(d.logPath)) != 1 {
				t.Fatal("missing log")
			}
		})
	}
}
func TestNexusEmptyRoster(t *testing.T) {
	d := nexusFixture(t)
	d.model = func(context.Context, string, string, []byte) ([]byte, error) {
		t.Fatal("model called")
		return nil, nil
	}
	r := nexusRoute(context.Background(), d, "hi", nil)
	if r.Action != "error" || r.Error != "Head가 없습니다" {
		t.Fatal(r)
	}
}
func TestNexusSanitize(t *testing.T) {
	for _, tc := range []struct{ in, want string }{{" \x00a\x1b\nb\tc\x7f ", "a\nb\tc"}, {strings.Repeat("가", 5000), strings.Repeat("가", 4000)}} {
		if got := nexusSanitize(tc.in); got != tc.want {
			t.Fatalf("got %q", got)
		}
	}
}
func TestNexusLog(t *testing.T) {
	d := nexusFixture(t)
	for i := 0; i < 60; i++ {
		if err := nexusAppendLog(d.logPath, nexusLogEntry{At: fmt.Sprint(i), Text: fmt.Sprintf("entry-%02d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	log := nexusLoadLog(d.logPath)
	if len(log) != 50 || log[0].Text != "entry-10" || log[49].Text != "entry-59" {
		t.Fatal(log)
	}
	st, _ := os.Stat(d.logPath)
	if st.Mode().Perm() != 0600 {
		t.Fatal(st.Mode())
	}
	d.model = func(_ context.Context, sys, p string, s []byte) ([]byte, error) {
		if strings.Count(p, "entry-") != 6 || strings.Contains(p, "entry-53") {
			t.Fatal(p)
		}
		return []byte(`{"action":"ask","question":"which?"}`), nil
	}
	nexusRoute(context.Background(), d, "hello", nexusRoster())
}
func TestCmdNexus(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	for _, args := range [][]string{nil, {"wat"}, {"route"}, {"send", "--text", "hi", "--roster", "[]"}, {"route", "--text", "hi", "--roster", "{"}, {"route", "--text", "hi", "--roster", "null"}, {"log", "--limit", "-1"}, {"listen"}, {"listen", "wat"}, {"listen", "status", "--hints", "head"}, {"listen", "stop", "--hints", "head"}, {"listen", "status", "extra"}, {"listen", "stop", "--pid", "0"}, {"listen", "stop", "--pid", "bad"}, {"listen", "start", "--pid", "123"}, {"listen", "status", "--pid", "123"}, {"log", "extra"}} {
		var out, stderr bytes.Buffer
		if code := cmdNexus(args, &out, &stderr); code != 2 {
			t.Fatalf("%v: %d %s", args, code, out.String())
		}
	}
	path := filepath.Join(hudCacheDir(), "nexus-log.json")
	for i := 0; i < 5; i++ {
		if err := nexusAppendLog(path, nexusLogEntry{Text: fmt.Sprint(i)}); err != nil {
			t.Fatal(err)
		}
	}
	var out, stderr bytes.Buffer
	if code := cmdNexus([]string{"log", "--limit", "3"}, &out, &stderr); code != 0 {
		t.Fatal(code, stderr.String())
	}
	var reply struct{ Entries []nexusLogEntry }
	if err := json.Unmarshal(out.Bytes(), &reply); err != nil || len(reply.Entries) != 3 || reply.Entries[0].Text != "2" {
		t.Fatal(out.String(), err)
	}
}
func TestNexusClaudeOutput(t *testing.T) {
	for _, tc := range []struct {
		raw, want string
		bad       bool
	}{{`{"structured_output":{"action":"ask"}}`, `{"action":"ask"}`, false}, {`{"result":"{\"action\":\"ask\"}"}`, `{"action":"ask"}`, false}, {`{"is_error":true,"result":"bad"}`, "", true}, {`{`, "", true}, {`{"result":"no json"}`, "", true}} {
		got, err := nexusClaudeOutput([]byte(tc.raw))
		if (err != nil) != tc.bad || string(got) != tc.want {
			t.Fatal(string(got), err)
		}
	}
}

func TestNexusLogFailurePreservesReply(t *testing.T) {
	for _, mode := range []string{"route", "send"} {
		t.Run(mode, func(t *testing.T) {
			d := nexusFixture(t)
			parent := filepath.Join(t.TempDir(), "file")
			if err := os.WriteFile(parent, nil, 0600); err != nil {
				t.Fatal(err)
			}
			d.logPath = filepath.Join(parent, "log.json")
			calls := 0
			d.hc = func(context.Context, ...string) ([]byte, error) { calls++; return nil, nil }
			var r nexusReply
			if mode == "route" {
				r = nexusRoute(context.Background(), d, "hello", nexusRoster())
			} else {
				r = nexusSend(context.Background(), d, "t1", "hello", nexusRoster())
			}
			if r.Action != "send" || !r.Sent || r.Error != "" || !strings.HasPrefix(r.Warning, "기록을 남기지 못했습니다: ") || calls != 1 {
				t.Fatalf("%+v calls=%d", r, calls)
			}
		})
	}
}

func TestNexusIncompleteRoster(t *testing.T) {
	for _, tc := range []struct {
		name       string
		loaded     bool
		panesError string
		want       int
	}{
		{"complete", true, "", 1}, {"unknown labels", false, "", 0}, {"panes error", true, "failed", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			panes := HUDPanes{Error: tc.panesError, Terminals: []HUDTerminal{{Address: "t1", Program: "claude", detailLoaded: tc.loaded}}}
			if got := nexusValidRoster(nexusRoster(), panes); len(got) != tc.want {
				t.Fatal(got)
			}
			if tc.panesError == "" {
				return
			}
			for _, mode := range []string{"route", "send"} {
				d := nexusFixture(t)
				d.panes = func(context.Context) HUDPanes { return panes }
				d.model = func(context.Context, string, string, []byte) ([]byte, error) {
					t.Fatal("model called")
					return nil, nil
				}
				d.hc = func(context.Context, ...string) ([]byte, error) { t.Fatal("hc called"); return nil, nil }
				var r nexusReply
				if mode == "route" {
					r = nexusRoute(context.Background(), d, "hi", nexusRoster())
				} else {
					r = nexusSend(context.Background(), d, "t1", "hi", nexusRoster())
				}
				if r.Error != "Head 목록을 확인하지 못했습니다" {
					t.Fatal(r)
				}
			}
		})
	}
}

func TestNexusReadRejected(t *testing.T) {
	d := nexusFixture(t)
	d.model = func(context.Context, string, string, []byte) ([]byte, error) {
		return []byte(`{"action":"read","target":"t1"}`), nil
	}
	d.hc = func(context.Context, ...string) ([]byte, error) { t.Fatal("read must not reach hc"); return nil, nil }
	if r := nexusRoute(context.Background(), d, "상태 알려줘", nexusRoster()); r.Action != "error" {
		t.Fatal(r)
	}
}

func TestNexusCommandWaitDelay(t *testing.T) {
	for _, name := range []string{"claude", "codex", "hc"} {
		t.Run(name, func(t *testing.T) {
			if cmd := nexusCommand(context.Background(), name, "--help"); cmd.WaitDelay != 2*time.Second {
				t.Fatal(cmd.WaitDelay)
			}
		})
	}
}

func TestNexusKoreanErrors(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{context.DeadlineExceeded, "모델 호출 시간이 초과됐습니다"},
		{errors.New("failed"), "요청을 처리하지 못했습니다: failed"},
		{errors.New("hc를 찾을 수 없습니다"), "hc를 찾을 수 없습니다"},
	} {
		if got := nexusError(tc.err); got.Error != tc.want {
			t.Fatal(got)
		}
	}
}

func TestNexusHCErrorPassthrough(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want string
	}{
		{"stderr", errors.New("hc: target vanished"), "hc: target vanished"},
		{"bounded stderr", errors.New(strings.Repeat("x", 400)), strings.Repeat("x", 300)},
		{"deadline", fmt.Errorf("hc runner: %w", context.DeadlineExceeded), "Head에 보내는 시간이 초과됐습니다"},
	} {
		for _, mode := range []string{"send", "route"} {
			t.Run(tc.name+"/"+mode, func(t *testing.T) {
				d := nexusFixture(t)
				d.hc = func(context.Context, ...string) ([]byte, error) { return nil, tc.err }
				var got nexusReply
				if mode == "send" {
					got = nexusSend(context.Background(), d, "t1", "hello", nexusRoster())
				} else {
					got = nexusRoute(context.Background(), d, "hello", nexusRoster())
				}
				if got.Error != tc.want || got.Sent {
					t.Fatalf("%+v", got)
				}
			})
		}
	}
}

func TestNexusModelDeadline(t *testing.T) {
	for _, err := range []error{context.DeadlineExceeded, fmt.Errorf("model runner: %w", context.DeadlineExceeded)} {
		t.Run(err.Error(), func(t *testing.T) {
			d := nexusFixture(t)
			d.model = func(context.Context, string, string, []byte) ([]byte, error) { return nil, err }
			d.hc = func(context.Context, ...string) ([]byte, error) { t.Fatal("deadline sent a command"); return nil, nil }
			got := nexusRoute(context.Background(), d, "hello", nexusRoster())
			if got.Error != "모델 호출 시간이 초과됐습니다" || got.Sent {
				t.Fatalf("%+v", got)
			}
		})
	}
}

func TestNexusPrefilter(t *testing.T) {
	for _, tc := range []struct {
		text, cleaned string
		ignore        bool
	}{
		{"ㅋㅋㅋ", "", true},
		{"하하하 음", "", true},
		{"음 어 ontology에 테스트 돌려 ㅋㅋ", "ontology에 테스트 돌려", false},
		{"그거 다시 해", "그거 다시 해", false},
		{"어디까지 했어", "어디까지 했어", false},
		{"아까 그거", "아까 그거", false},
		{"(웃음) 빌드 봐줘", "빌드 봐줘", false},
		{"저기 그 음… 빌드 어어 봐줘", "빌드 봐줘", false},
		{"푸하하 으흐흐 헤헤 히히 크크 킥킥 허허 [웃음] LOL haha hehe", "", true},
		{"아!?", "아!?", false},
		{"a1", "a1", false},
		{"하하호호 프로젝트 테스트 돌려", "하하호호 프로젝트 테스트 돌려", false},
		{"lollipop 앱 빌드", "lollipop 앱 빌드", false},
		{"허허벌판 앱 배포", "허허벌판 앱 배포", false},
		{"흐흐 흐름도 그려줘", "흐름도 그려줘", false},
		{"크크크 게임 서버", "게임 서버", false},
		{"아하하 그렇구나", "그렇구나", false},
		{"test haha 서버", "test 서버", false},
		{"ha ha ha", "", true},
		{"하 하 하", "", true},
		{"ha ha", "ha ha", false},
		{"하 헤 하", "하 헤 하", false},
		{"~하하! …LOL?, [웃음]! 호호", "", true},
		{"2", "2", false},
		{"네", "네", false},
		{"y", "y", false},
		{"응", "응", false},
		{"!?", "!?", true},
		{"빌드 그 저기 확인", "빌드 그 저기 확인", false},
	} {
		t.Run(tc.text, func(t *testing.T) {
			cleaned, ignore := nexusPrefilter(tc.text)
			if cleaned != tc.cleaned || ignore != tc.ignore {
				t.Fatalf("got %q, %v; want %q, %v", cleaned, ignore, tc.cleaned, tc.ignore)
			}
		})
	}
}

func TestNexusIgnore(t *testing.T) {
	for _, tc := range []struct {
		text       string
		modelCalls int
		summary    string
	}{
		{"ㅋㅋㅋ", 0, nexusIgnoreSummary},
		{"잠깐만", 1, "잠시 기다리는 말입니다"},
	} {
		t.Run(tc.text, func(t *testing.T) {
			d := nexusFixture(t)
			models, hc, panes := 0, 0, 0
			originalPanes := d.panes
			d.panes = func(ctx context.Context) HUDPanes { panes++; return originalPanes(ctx) }
			d.model = func(context.Context, string, string, []byte) ([]byte, error) {
				models++
				return []byte(`{"action":"ignore","target":"bad","message":"do not send","summary":"잠시 기다리는 말입니다"}`), nil
			}
			d.hc = func(context.Context, ...string) ([]byte, error) { hc++; return nil, nil }
			reply := nexusRoute(context.Background(), d, tc.text, nexusRoster())
			if reply.Local != (tc.modelCalls == 0) || reply.Action != "ignore" || reply.Sent || reply.Summary != tc.summary || reply.Target != "" || reply.Message != "" {
				t.Fatalf("%+v", reply)
			}
			if models != tc.modelCalls || hc != 0 || (models == 0 && panes != 0) {
				t.Fatalf("model=%d hc=%d panes=%d", models, hc, panes)
			}
			if _, err := os.Stat(d.logPath); !os.IsNotExist(err) {
				t.Fatalf("ignore wrote log: %v", err)
			}
		})
	}
}

func TestNexusModelReceivesCleanedSpeech(t *testing.T) {
	d := nexusFixture(t)
	d.model = func(_ context.Context, sys, prompt string, schema []byte) ([]byte, error) {
		if !strings.HasSuffix(prompt, "User command:\nontology에 테스트 돌려") {
			t.Fatal(prompt)
		}
		if !strings.Contains(sys, "self-corrections") || !strings.Contains(string(schema), `"ignore"`) {
			t.Fatal("missing speech routing instructions")
		}
		return []byte(`{"action":"send","target":"t1","message":"테스트 돌려","confidence":0.9}`), nil
	}
	if r := nexusRoute(context.Background(), d, "음 어 ontology에 테스트 돌려 ㅋㅋ", nexusRoster()); !r.Sent {
		t.Fatal(r)
	}
}

func TestNexusIgnoreSummaryBound(t *testing.T) {
	d := nexusFixture(t)
	d.model = func(context.Context, string, string, []byte) ([]byte, error) {
		return json.Marshal(map[string]string{"action": "ignore", "summary": strings.Repeat("긴", 250)})
	}
	reply := nexusRoute(context.Background(), d, "잠깐만", nexusRoster())
	if reply.Action != "ignore" || reply.Local || reply.Summary != strings.Repeat("긴", 200) {
		t.Fatalf("%+v", reply)
	}
	raw, err := json.Marshal(reply)
	if err != nil || strings.Contains(string(raw), `"local"`) {
		t.Fatalf("model reply local marker: %s, %v", raw, err)
	}
}

func TestNexusAudioConfig(t *testing.T) {
	for _, tc := range []struct {
		raw       string
		keep      int
		threshold float64
		model     string
	}{
		{`{}`, 0, 0, ""},
		{`{"model":"codex-low-h","keepAudio":2,"laughThreshold":0.7}`, 2, 0.7, "codex-low-h"},
		{`{"Model":"codex-low-h"}`, 0, 0, "codex-low-h"},
		{`{"KEEPAUDIO":5}`, 5, 0, ""},
		{`{"mOdEl":"codex-low-h","KEEPAUDIO":"bad","LAUGHTHRESHOLD":0.7}`, 0, 0.7, "codex-low-h"},
		{`{"keepAudio":100,"laughThreshold":0.99}`, 100, 0.99, ""},
		{`{"keepAudio":0,"laughThreshold":0.1}`, 0, 0.1, ""},
		{`{"keepAudio":-1,"laughThreshold":0.09}`, 0, 0, ""},
		{`{"keepAudio":101,"laughThreshold":1}`, 0, 0, ""},
		{`{"model":"claude-medium-m","keepAudio":1.5,"laughThreshold":"0.7"}`, 0, 0, "claude-medium-m"},
		{`{"model":"codex-low-h","keepAudio":"2","laughThreshold":0.5}`, 0, 0.5, "codex-low-h"},
		{`{"model":false,"keepAudio":2,"laughThreshold":null}`, 2, 0, ""},
		{`{`, 0, 0, ""},
	} {
		got := nexusParseConfig([]byte(tc.raw))
		if got.KeepAudio != tc.keep || got.LaughThreshold != tc.threshold || got.Model != tc.model {
			t.Fatalf("%s: %+v", tc.raw, got)
		}
	}
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	if err := os.MkdirAll(filepath.Join(dir, "herdr-hud"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "herdr-hud/nexus.json"), []byte(`{"model":"codex-low-h","keepAudio":2,"laughThreshold":0.7}`), 0600); err != nil {
		t.Fatal(err)
	}
	if got := nexusLoadConfig(); got.Model != "codex-low-h" || got.KeepAudio != 2 || got.LaughThreshold != 0.7 {
		t.Fatal(got)
	}
}

func TestNexusPolishedMultiline(t *testing.T) {
	d := nexusFixture(t)
	message := "넥서스 확인해.\n테스트도 돌려줘."
	d.model = func(_ context.Context, sys, _ string, _ []byte) ([]byte, error) {
		for _, rule := range []string{"speech-recognition errors using Head names and project context", "repetitions, duplicated sentences, fillers", "laughter", "punctuation and line breaks", "Drop the Head-naming part", "Keep the meaning, tone and language", "Never add requests, facts or politeness"} {
			if !strings.Contains(sys, rule) {
				t.Errorf("missing rule %q", rule)
			}
		}
		return json.Marshal(map[string]any{"action": "send", "target": "t1", "message": message, "confidence": 0.99})
	}
	d.hc = func(_ context.Context, args ...string) ([]byte, error) {
		if !reflect.DeepEqual(args, []string{"send", "--", "t1", "넥서스 확인해. 테스트도 돌려줘."}) {
			t.Fatal(args)
		}
		return nil, nil
	}
	if got := nexusRoute(context.Background(), d, "head 액서스 확인해 테스트도 돌려줘", nexusRoster()); !got.Sent || got.Message != message {
		t.Fatal(got)
	}
}

func TestNexusSendMultiline(t *testing.T) {
	d := nexusFixture(t)
	message := "첫 문장.\r\n\n다음 문장."
	d.hc = func(_ context.Context, args ...string) ([]byte, error) {
		if !reflect.DeepEqual(args, []string{"send", "--", "t1", "첫 문장. 다음 문장."}) {
			t.Fatal(args)
		}
		return nil, nil
	}
	got := nexusSend(context.Background(), d, "t1", message, nexusRoster())
	if !got.Sent || got.Message != nexusSanitize(message) {
		t.Fatal(got)
	}
}
