package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const (
	linearTestOldState   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	linearTestDoneState  = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
	linearTestLaterState = "cccccccc-cccc-cccc-cccc-cccccccccccc"
)

func linearStateReply(t *testing.T, args []string, exit int, source, wantError string) linearStatePayload {
	t.Helper()
	code, stdout, stderr := linearRun(t, args...)
	if strings.Contains(stdout+stderr, linearTestAPIKey) || strings.Contains(stdout+stderr, linearTestMCPToken) {
		t.Fatal("credential leaked in state response")
	}
	var out linearStatePayload
	var fields map[string]json.RawMessage
	if code != exit || stderr != "" || json.Unmarshal([]byte(stdout), &out) != nil ||
		json.Unmarshal([]byte(stdout), &fields) != nil || len(fields) != 7 ||
		!reflect.DeepEqual(out.Source, linearOptional(source)) || !reflect.DeepEqual(out.Error, linearOptional(wantError)) {
		t.Fatalf("unexpected state response: %d %q %q", code, stdout, stderr)
	}
	for _, key := range []string{"source", "identifier", "status", "status_type", "previous", "previous_status", "error"} {
		if _, ok := fields[key]; !ok {
			t.Fatalf("missing field %s in %s", key, stdout)
		}
	}
	return out
}

func linearStateCache(t *testing.T) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(linearCachePath()), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(linearCachePath(), []byte("cached snapshot"), 0600); err != nil {
		t.Fatal(err)
	}
}

func linearAssertStateCache(t *testing.T, removed bool) {
	t.Helper()
	data, err := os.ReadFile(linearCachePath())
	if removed {
		if !os.IsNotExist(err) {
			t.Fatalf("cache still exists or cannot be checked: %v", err)
		}
	} else if err != nil || string(data) != "cached snapshot" {
		t.Fatalf("cache changed on failure: %q, %v", data, err)
	}
}

func TestLinearStateGraphQL(t *testing.T) {
	started := fmt.Sprintf(`{"identifier":"FIX-12","state":{"id":%q,"name":"In Progress","type":"started"}}`, linearTestOldState)
	done := fmt.Sprintf(`{"identifier":"FIX-12","state":{"id":%q,"name":"Done","type":"completed"}}`, linearTestDoneState)
	nodes := fmt.Sprintf(`[{"id":%q,"name":"Later","position":20},{"id":%q,"name":"Done","position":10}]`, linearTestLaterState, linearTestDoneState)
	read := func(issue, nodes string) string {
		return `{"data":{"issue":` + strings.TrimSuffix(issue, "}") + `,"team":{"states":{"nodes":` + nodes + `}}}}}`
	}
	updated := func(issue string) string {
		return `{"data":{"issueUpdate":{"success":true,"issue":` + issue + `}}}`
	}
	for _, tc := range []struct {
		name, first, mutation, stateID, token, wantError string
		status, statusType, previous, previousStatus     string
		exit, calls                                      int
		hideSource                                       bool
	}{
		{name: "complete", first: read(started, nodes), mutation: updated(done), stateID: linearTestDoneState,
			status: "Done", statusType: "completed", previous: linearTestOldState, previousStatus: "In Progress", calls: 2},
		{name: "already completed", first: read(done, "[]"), status: "Done", statusType: "completed",
			previous: linearTestDoneState, previousStatus: "Done", calls: 1},
		{name: "no completed state", first: read(started, "[]"), wantError: linearErrNoDoneState, calls: 1},
		{name: "missing issue", first: `{"data":{"issue":null}}`, wantError: linearErrNotFound, calls: 1},
		{name: "forbidden code", first: read(started, nodes), mutation: `{"errors":[{"extensions":{"code":"FORBIDDEN"}}]}`,
			stateID: linearTestDoneState, wantError: linearErrForbidden, calls: 2},
		{name: "write scope", first: read(started, nodes), mutation: `{"errors":[{"message":"Missing write scope"}]}`,
			stateID: linearTestDoneState, wantError: linearErrForbidden, calls: 2},
		{name: "auth precedes permission", first: read(started, nodes),
			mutation: `{"errors":[{"message":"Forbidden","extensions":{"code":"AUTHENTICATION_ERROR"}}]}`,
			stateID:  linearTestDoneState, wantError: linearErrInvalidKey, calls: 2},
		{name: "provider echoes key", first: read(started, nodes),
			mutation: updated(strings.Replace(done, `"Done"`, fmt.Sprintf("%q", linearTestAPIKey), 1)),
			stateID:  linearTestDoneState, wantError: linearErrBadResponse, calls: 2, hideSource: true},
		{name: "mutation failed", first: read(started, nodes), mutation: `{"data":{"issueUpdate":{"success":false}}}`,
			stateID: linearTestDoneState, wantError: linearErrBadResponse, calls: 2},
		{name: "restore", mutation: updated(started), stateID: strings.ToUpper(linearTestOldState),
			token: strings.ToUpper(linearTestOldState), status: "In Progress", statusType: "started", calls: 1},
		{name: "non-UUID restore", token: "In Progress", wantError: linearErrBadRequest, exit: 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := setupLinear(t)
			env.keychain.key = linearStoredJSON(linearTestAPIKey, "api_key:state-generation")
			linearStateCache(t)
			requests := graphQLServer(t, func(query string, vars map[string]any, w http.ResponseWriter) {
				switch query {
				case linearCompleteQuery:
					if !reflect.DeepEqual(vars, map[string]any{"id": "FIX-12"}) || tc.first == "" {
						t.Errorf("unexpected lookup variables %v", vars)
					}
					fmt.Fprint(w, tc.first)
				case linearUpdateStateMutation:
					if !reflect.DeepEqual(vars, map[string]any{"id": "FIX-12", "stateId": tc.stateID}) || tc.mutation == "" {
						t.Errorf("unexpected mutation variables %v", vars)
					}
					fmt.Fprint(w, tc.mutation)
				default:
					t.Errorf("unexpected GraphQL query %q", query)
				}
			})
			args := []string{"complete", "FIX-12"}
			if tc.token != "" {
				args = []string{"restore", "FIX-12", tc.token}
			}
			source := linearSourceAPIKey
			if tc.hideSource {
				source = ""
			}
			out := linearStateReply(t, args, tc.exit, source, tc.wantError)
			want := linearStatePayload{
				Source: linearOptional(source), Status: linearOptional(tc.status),
				StatusType: linearOptional(tc.statusType), Previous: linearOptional(tc.previous),
				PreviousStatus: linearOptional(tc.previousStatus), Error: linearOptional(tc.wantError),
			}
			if tc.wantError == "" {
				want.Identifier = strPtr("FIX-12")
			}
			if !reflect.DeepEqual(out, want) || len(*requests) != tc.calls {
				t.Fatalf("wrong state payload or request count: %+v, %d calls (want %d)", out, len(*requests), tc.calls)
			}
			for _, header := range *requests {
				if header.Get("Authorization") != linearTestAPIKey {
					t.Error("mutation path did not use active API key")
				}
			}
			linearAssertStateCache(t, tc.wantError == "")
		})
	}
}

func TestLinearStateMCP(t *testing.T) {
	const get = `{"name":"get_issue","inputSchema":{"properties":{"id":{"type":"string"}}}}`
	const save = `{"name":"save_issue","inputSchema":{"properties":{"id":{"type":"string"},"state":{"type":"string"}}}}`
	issue := func(status, kind string) string {
		return linearDetailMCPResult(fmt.Sprintf(`{"identifier":"FIX-12","title":"Issue","status":%q,"statusType":%q}`, status, kind))
	}
	started, done := issue("In Progress", "started"), issue("Done", "completed")
	for _, tc := range []struct {
		name, token, before, after, saveResult, wantError string
		omitSave                                          bool
		status, statusType, previous                      string
		tools                                             []string
	}{
		{name: "complete", before: started, after: done, status: "Done", statusType: "completed", previous: "In Progress",
			tools: []string{"get_issue", "save_issue", "get_issue"}},
		{name: "already completed", before: done, status: "Done", statusType: "completed", previous: "Done",
			tools: []string{"get_issue"}},
		{name: "restore by name", token: "In Progress", after: started, status: "In Progress", statusType: "started",
			tools: []string{"save_issue", "get_issue"}},
		{name: "forbidden text", before: started, saveResult: `{"isError":true,"content":[{"type":"text","text":"Error: Permission denied"}]}`,
			wantError: linearErrForbidden, tools: []string{"get_issue", "save_issue"}},
		{name: "missing save tool", omitSave: true, wantError: linearErrBadResponse},
		{name: "unconfirmed completion", before: started, after: started, wantError: linearErrBadResponse,
			tools: []string{"get_issue", "save_issue", "get_issue"}},
		{name: "provider echoes token", before: issue(linearTestMCPToken, "started"), wantError: linearErrBadResponse,
			tools: []string{"get_issue"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := setupLinear(t)
			env.claude = linearClaudeCreds(map[string]map[string]any{"linear|a": linearMCPCred(time.Now().Add(time.Hour).UnixMilli())})
			mcp := newFakeMCP(t)
			tools := get
			if !tc.omitSave {
				tools += "," + save
			}
			mcp.stateTools = `{"tools":[` + tools + `]}`
			mcp.issueResult, mcp.savedIssueResult = tc.before, tc.after
			mcp.saveResult = tc.saveResult
			if mcp.saveResult == "" {
				mcp.saveResult = linearDetailMCPResult("Updated issue")
			}
			linearStateCache(t)
			args := []string{"complete", "FIX-12"}
			state := "completed"
			if tc.token != "" {
				args = []string{"restore", "FIX-12", tc.token}
				state = tc.token
			}
			out := linearStateReply(t, args, 0, linearSourceClaudeMCP, tc.wantError)
			want := linearStatePayload{
				Source: strPtr(linearSourceClaudeMCP), Status: linearOptional(tc.status), StatusType: linearOptional(tc.statusType),
				Previous: linearOptional(tc.previous), PreviousStatus: linearOptional(tc.previous), Error: linearOptional(tc.wantError),
			}
			if tc.wantError == "" {
				want.Identifier = strPtr("FIX-12")
			}
			if !reflect.DeepEqual(out, want) {
				t.Fatalf("wrong state payload: %+v", out)
			}
			calls := mcp.calls()
			if len(calls) != 3+len(tc.tools) || calls[0].Method != "initialize" ||
				calls[1].Method != "notifications/initialized" || calls[2].Method != "tools/list" {
				t.Fatalf("unexpected MCP request sequence: %+v", calls)
			}
			for i, name := range tc.tools {
				var call struct {
					Name      string
					Arguments map[string]any
				}
				wantArgs := map[string]any{"id": "FIX-12"}
				if name == "save_issue" {
					wantArgs["state"] = state
				}
				req := calls[i+3]
				if req.Method != "tools/call" || json.Unmarshal(req.Params, &call) != nil ||
					call.Name != name || !reflect.DeepEqual(call.Arguments, wantArgs) ||
					req.Header.Get("Mcp-Session-Id") != "session-fixture" ||
					req.Header.Get("Authorization") != "Bearer "+linearTestMCPToken {
					t.Fatalf("unexpected request for %s: %s", name, req.Params)
				}
			}
			linearAssertStateCache(t, tc.wantError == "")
		})
	}
}

func TestLinearStateValidationAndBusy(t *testing.T) {
	env := setupLinear(t)
	env.keychain.key = linearStoredJSON(linearTestAPIKey, "api_key:state-generation")
	for _, args := range [][]string{
		{"complete"}, {"complete", "fix-12"}, {"complete", "FIX-12", "extra"},
		{"restore", "FIX-12"}, {"restore", "FIX-0", "Backlog"}, {"restore", "FIX-12", "Backlog", "extra"},
		{"restore", "FIX-12", ""}, {"restore", "FIX-12", strings.Repeat("한", 22)},
		{"restore", "FIX-12", " Backlog"}, {"restore", "FIX-12", "Backlog\u00a0"},
		{"restore", "FIX-12", "Back\u0085log"}, {"restore", "FIX-12", "Back\xfflog"},
	} {
		linearStateReply(t, args, 2, "", linearErrBadRequest)
	}
	if linearKeychainCalls(env) != 0 {
		t.Fatal("invalid input reached the credential store")
	}
	if code, _, _ := linearRun(t, "status"); code != 0 {
		t.Fatal("could not initialize credential lock")
	}
	if err := os.Chmod(linearLockPath(), 0400); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(linearLockPath(), 0600) })
	calls := linearKeychainCalls(env)
	linearStateReply(t, []string{"complete", "FIX-12"}, 0, "", linearErrBusy)
	linearStateReply(t, []string{"restore", "FIX-12", linearTestOldState}, 0, "", linearErrBusy)
	if linearKeychainCalls(env) != calls {
		t.Fatal("busy state command reached the credential store")
	}
}

func TestLinearStateCredentialErrors(t *testing.T) {
	env := setupLinear(t)
	linearStateReply(t, []string{"complete", "FIX-12"}, 0, "", linearErrNotConnected)
	env.claude = linearClaudeCreds(map[string]map[string]any{"linear|expired": linearMCPCred(time.Now().Add(-time.Hour).UnixMilli())})
	linearStateReply(t, []string{"restore", "FIX-12", "Backlog"}, 0, linearSourceClaudeMCP, linearErrExpired)
}
