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

func TestLinearIssueInvalidIDBeforeCredentialResolution(t *testing.T) {
	env := setupLinear(t)
	env.keychain.key = linearStoredJSON(linearTestAPIKey, "api_key:detail-generation")
	requests := graphQLServer(t, func(_ string, _ map[string]any, w http.ResponseWriter) {
		http.Error(w, "unexpected request", http.StatusBadRequest)
	})
	for _, args := range [][]string{
		{}, {"fix-1"}, {"F-0"}, {"F-01"}, {"F-1234567890"}, {"ABCDEFGHIJK-1"},
		{"1FIX-1"}, {"FIX_2-1"}, {"FIX-1\n"}, {"FIX-1", "extra"}, {linearTestAPIKey},
	} {
		code, stdout, stderr := linearRun(t, append([]string{"issue"}, args...)...)
		if code != 2 || stdout != "{\"source\":null,\"issue\":null,\"error\":\"bad_request\"}\n" || stderr != "" {
			t.Fatalf("unexpected validation response: %d %q %q", code, stdout, stderr)
		}
	}
	if len(*requests) != 0 || linearKeychainCalls(env) != 0 {
		t.Fatal("invalid input reached a credential or HTTP request")
	}
	if _, err := os.Stat(linearLockPath()); !os.IsNotExist(err) {
		t.Fatalf("invalid input touched credential lock: %v", err)
	}
	for _, id := range []string{"A-1", "AB23456789-123456789"} {
		if !linearDetailIdentifierPattern.MatchString(id) {
			t.Errorf("rejected valid boundary %q", id)
		}
	}
}

func TestLinearIssueBusyBeforeCredentialResolution(t *testing.T) {
	env := setupLinear(t)
	env.keychain.key = linearStoredJSON(linearTestAPIKey, "api_key:detail-generation")
	code, _, _ := linearRun(t, "status")
	if code != 0 {
		t.Fatal("could not initialize the credential lock")
	}
	if err := os.Chmod(linearLockPath(), 0400); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(linearLockPath(), 0600) })
	calls := linearKeychainCalls(env)
	linearDetailReply(t, "FIX-12", "", linearErrBusy)
	if linearKeychainCalls(env) != calls {
		t.Fatal("busy issue detail reached the credential store")
	}
}

func linearDetailReply(t *testing.T, identifier, source, wantError string) *linearIssueDetail {
	t.Helper()
	code, stdout, stderr := linearRun(t, "issue", identifier)
	if strings.Contains(stdout+stderr, linearTestAPIKey) || strings.Contains(stdout+stderr, linearTestMCPToken) {
		t.Fatal("credential leaked in output")
	}
	var out linearIssuePayload
	if code != 0 || stderr != "" || json.Unmarshal([]byte(stdout), &out) != nil {
		t.Fatalf("unexpected detail response: %d %q %q", code, stdout, stderr)
	}
	if source == "" {
		if out.Source != nil {
			t.Fatalf("unexpected source in %s", stdout)
		}
	} else if out.Source == nil || *out.Source != source {
		t.Fatalf("wrong source in %s", stdout)
	}
	if wantError != "" {
		if out.Issue != nil || out.Error == nil || *out.Error != wantError {
			t.Fatalf("wanted error %q in %s", wantError, stdout)
		}
	} else if out.Issue == nil || out.Error != nil {
		t.Fatalf("wanted issue details in %s", stdout)
	}
	return out.Issue
}

func TestLinearIssueGraphQL(t *testing.T) {
	env := setupLinear(t)
	env.keychain.key = linearStoredJSON(linearTestAPIKey, "api_key:detail-generation")
	env.claude = linearClaudeCreds(map[string]map[string]any{"linear|a": linearMCPCred(time.Now().Add(time.Hour).UnixMilli())})
	description := strings.Repeat("한", linearDetailMaxDescription) + "extra"
	labels := make([]map[string]string, 22)
	for i := range labels {
		labels[i] = map[string]string{"name": fmt.Sprintf("label-%d", i)}
	}
	requests := graphQLServer(t, func(query string, vars map[string]any, w http.ResponseWriter) {
		if !strings.Contains(query, "issue(id: $id)") || !strings.Contains(query, "labels(first: 20)") ||
			!reflect.DeepEqual(vars, map[string]any{"id": "FIX-12"}) {
			t.Errorf("unexpected issue request: %q %v", query, vars)
		}
		body := map[string]any{"data": map[string]any{"issue": map[string]any{
			"identifier": "FIX-12", "title": "Issue title", "url": "https://linear.app/fixture/issue/FIX-12",
			"priority": 2, "description": description, "dueDate": "2027-01-09", "updatedAt": "2026-11-19T01:24:02Z",
			"state": map[string]string{"name": "In progress", "type": "started"}, "project": nil,
			"team": map[string]string{"key": "FIX"}, "assignee": map[string]string{"name": "Fixture User"},
			"labels": map[string]any{"nodes": labels},
		}}}
		_ = json.NewEncoder(w).Encode(body)
	})
	got := linearDetailReply(t, "FIX-12", linearSourceAPIKey, "")
	wantLabels := make([]string, linearDetailMaxLabels)
	for i := range wantLabels {
		wantLabels[i] = labels[i]["name"]
	}
	want := &linearIssueDetail{
		Identifier: "FIX-12", Title: "Issue title", URL: strPtr("https://linear.app/fixture/issue/FIX-12"),
		Status: strPtr("In progress"), StatusType: strPtr("started"), Priority: new(2), TeamKey: strPtr("FIX"),
		DueDate: strPtr("2027-01-09"), UpdatedAt: strPtr("2026-11-19T01:24:02Z"), Assignee: strPtr("Fixture User"),
		Labels: wantLabels, Description: strPtr(strings.Repeat("한", linearDetailMaxDescription) + "…"),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("wrong detail payload: %+v", got)
	}
	if len(*requests) != 1 || (*requests)[0].Get("Authorization") != linearTestAPIKey {
		t.Fatal("issue request did not use the API key route once")
	}
	linearAssertDetailNoCache(t, env)
}

func TestLinearIssueGraphQLErrors(t *testing.T) {
	for _, tc := range []struct {
		name, body, code string
	}{
		{"missing", `{"errors":[{"message":"Entity not found: ` + linearTestAPIKey + `"}]}`, linearErrNotFound},
		{"missing entity code", `{"errors":[{"extensions":{"code":"ENTITY_NOT_FOUND"}}]}`, linearErrNotFound},
		{"missing issue code", `{"errors":[{"extensions":{"code":"ISSUE_NOT_FOUND"}}]}`, linearErrNotFound},
		{"field not found", `{"errors":[{"message":"Field issue not found on Query"}]}`, linearErrBadResponse},
		{"generic not found code", `{"errors":[{"extensions":{"code":"NOT_FOUND"}}]}`, linearErrBadResponse},
		{"auth", `{"errors":[{"message":"Token not found","extensions":{"code":"AUTHENTICATION_ERROR"}}]}`, linearErrInvalidKey},
		{"null issue", `{"data":{"issue":null}}`, linearErrNotFound},
		{"missing field", `{"data":{}}`, linearErrBadResponse},
		{"wrong issue", `{"data":{"issue":{"identifier":"FIX-13","title":"Other"}}}`, linearErrBadResponse},
		{"echo in success", `{"data":{"issue":{"identifier":"FIX-12","title":"Issue","description":"` + linearTestAPIKey + `"}}}`, linearErrBadResponse},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := setupLinear(t)
			env.keychain.key = linearStoredJSON(linearTestAPIKey, "api_key:detail-generation")
			graphQLServer(t, func(_ string, _ map[string]any, w http.ResponseWriter) {
				fmt.Fprint(w, tc.body)
			})
			linearDetailReply(t, "FIX-12", linearSourceAPIKey, tc.code)
			linearAssertDetailNoCache(t, env)
		})
	}
}

func TestLinearMissingEntityErrorOnOtherGraphQLQueries(t *testing.T) {
	setupLinear(t)
	graphQLServer(t, func(_ string, _ map[string]any, w http.ResponseWriter) {
		fmt.Fprint(w, `{"errors":[{"message":"Entity not found","extensions":{"code":"ENTITY_NOT_FOUND"}}]}`)
	})
	_, err := linearGraphQLIssues(t.Context(), linearTestAPIKey)
	if code := linearCode(err); code != linearErrBadResponse {
		t.Fatalf("got %q, want %q", code, linearErrBadResponse)
	}
}

func linearDetailMCPResult(content string) string {
	text, _ := json.Marshal(content)
	return fmt.Sprintf(`{"content":[{"type":"text","text":%s}]}`, text)
}

func TestLinearIssueMCPJSONAndSSE(t *testing.T) {
	for _, sse := range []bool{false, true} {
		t.Run(fmt.Sprintf("sse=%v", sse), func(t *testing.T) {
			env := setupLinear(t)
			env.claude = linearClaudeCreds(map[string]map[string]any{"linear|a": linearMCPCred(time.Now().Add(time.Hour).UnixMilli())})
			mcp := newFakeMCP(t)
			mcp.sse = sse
			mcp.issueResult = linearDetailMCPResult(`{
				"id":"f3c25e1d-3ec0-4e2a-848a-18fb347625bf","identifier":"FIX-12","title":"Issue title",
				"status":"In review","statusType":"custom","priority":{"value":3},"project":"Fixture / HUD",
				"team":"Fixture","assignee":{"name":"Fixture User"},"labels":["one",{"name":"two"}],
				"description":"Full description","dueDate":null}`)
			got := linearDetailReply(t, "FIX-12", linearSourceClaudeMCP, "")
			want := &linearIssueDetail{
				Identifier: "FIX-12", Title: "Issue title", Status: strPtr("In review"),
				StatusType: strPtr(""), Priority: new(3), Project: strPtr("Fixture / HUD"),
				TeamKey: strPtr("FIX"), Assignee: strPtr("Fixture User"), Labels: []string{"one", "two"},
				Description: strPtr("Full description"),
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("wrong detail payload: %+v", got)
			}
			var methods []string
			calls := mcp.calls()
			for _, call := range calls {
				methods = append(methods, call.Method)
				if call.Header.Get("Authorization") != "Bearer "+linearTestMCPToken {
					t.Fatalf("wrong authorization for %s", call.Method)
				}
			}
			if !reflect.DeepEqual(methods, []string{"initialize", "notifications/initialized", "tools/list", "tools/call"}) {
				t.Fatalf("unexpected methods %v", methods)
			}
			var call struct {
				Name      string
				Arguments map[string]any
			}
			if err := json.Unmarshal(calls[3].Params, &call); err != nil || call.Name != "get_issue" ||
				!reflect.DeepEqual(call.Arguments, map[string]any{"id": "FIX-12"}) {
				t.Fatalf("unexpected tool call: %s", calls[3].Params)
			}
			linearAssertDetailNoCache(t, env)
		})
	}
}

func TestLinearIssueMCPErrors(t *testing.T) {
	for _, tc := range []struct {
		name, result, code string
		noTool             bool
		wantCalls          int
	}{
		{"missing tool", "", linearErrBadResponse, true, 3},
		{"missing issue", `{"isError":true,"content":[{"type":"text","text":"Issue not found: ` + linearTestMCPToken + `"}]}`, linearErrNotFound, false, 4},
		{"missing entity in text", linearDetailMCPResult("Entity not found"), linearErrNotFound, false, 4},
		{"missing named issue", linearDetailMCPResult(`Issue "FIX-12" was not found`), linearErrNotFound, false, 4},
		{"missing issue with identifier", linearDetailMCPResult("Issue with identifier FIX-12 not found"), linearErrNotFound, false, 4},
		{"missing referenced issue", linearDetailMCPResult("Could not find referenced Issue"), linearErrNotFound, false, 4},
		{"no issue found", linearDetailMCPResult("No issue found"), linearErrNotFound, false, 4},
		{"tool not found in text", linearDetailMCPResult("tool get_issue not found"), linearErrBadResponse, false, 4},
		{"token not found in text", linearDetailMCPResult("token not found"), linearErrExpired, false, 4},
		{"unauthorized", linearDetailMCPResult("unauthorized"), linearErrExpired, false, 4},
		{"tool not found in error", `{"isError":true,"content":[{"type":"text","text":"Tool for issue not found"}]}`, linearErrBadResponse, false, 4},
		{"missing token", `{"isError":true,"content":[{"type":"text","text":"Error: Access token not found"}]}`, linearErrExpired, false, 4},
		{"invalid token", linearDetailMCPResult("Invalid token for issue lookup: issue not found"), linearErrExpired, false, 4},
		{"forbidden", linearDetailMCPResult("Forbidden: issue not found"), linearErrForbidden, false, 4},
		{"echo in error", `{"isError":true,"content":[{"type":"text","text":"Error: ` + linearTestMCPToken + `"}]}`, linearErrBadResponse, false, 4},
		{"echo in success", linearDetailMCPResult(`{"id":"FIX-12","title":"Issue","labels":["` + linearTestMCPToken + `"]}`), linearErrBadResponse, false, 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := setupLinear(t)
			env.claude = linearClaudeCreds(map[string]map[string]any{"linear|a": linearMCPCred(time.Now().Add(time.Hour).UnixMilli())})
			mcp := newFakeMCP(t)
			mcp.noIssueTool = tc.noTool
			mcp.issueResult = tc.result
			linearDetailReply(t, "FIX-12", linearSourceClaudeMCP, tc.code)
			if got := len(mcp.calls()); got != tc.wantCalls {
				t.Fatalf("made %d HTTP requests, want %d", got, tc.wantCalls)
			}
			linearAssertDetailNoCache(t, env)
		})
	}
}

func linearAssertDetailNoCache(t *testing.T, env *linearEnv) {
	t.Helper()
	if _, err := os.Stat(linearCachePath()); !os.IsNotExist(err) {
		t.Fatalf("issue detail touched issues cache: %v", err)
	}
	for _, root := range []string{env.config, env.cache} {
		err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return err
			}
			raw, err := os.ReadFile(path)
			if strings.Contains(string(raw), linearTestAPIKey) || strings.Contains(string(raw), linearTestMCPToken) {
				t.Fatalf("credential persisted in %s", path)
			}
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}
