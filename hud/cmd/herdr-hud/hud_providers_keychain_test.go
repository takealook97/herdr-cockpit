package main

import (
	"context"
	"errors"
	"os/user"
	"reflect"
	"testing"
)

func TestHUDClaudeKeychainRead(t *testing.T) {
	originalUser, originalRun := hudClaudeCurrentUser, hudClaudeSecurityRun
	t.Cleanup(func() { hudClaudeCurrentUser, hudClaudeSecurityRun = originalUser, originalRun })

	for _, tc := range []struct {
		name       string
		username   string
		userErr    error
		envUser    string
		scopedErr  error
		scopedData []byte
		wantCalls  [][]string
		want       string
	}{
		{name: "account found", username: "alice", scopedData: []byte("scoped"), wantCalls: [][]string{{"find-generic-password", "-s", "service", "-a", "alice", "-w"}}, want: "scoped"},
		{name: "account lookup fails", username: "alice", scopedErr: errors.New("missing"), wantCalls: [][]string{{"find-generic-password", "-s", "service", "-a", "alice", "-w"}, {"find-generic-password", "-s", "service", "-w"}}, want: "fallback"},
		{name: "account output empty", username: "alice", wantCalls: [][]string{{"find-generic-password", "-s", "service", "-a", "alice", "-w"}, {"find-generic-password", "-s", "service", "-w"}}, want: "fallback"},
		{name: "environment username", userErr: errors.New("unavailable"), envUser: "bob", scopedData: []byte("scoped"), wantCalls: [][]string{{"find-generic-password", "-s", "service", "-a", "bob", "-w"}}, want: "scoped"},
		{name: "no username", wantCalls: [][]string{{"find-generic-password", "-s", "service", "-w"}}, want: "fallback"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("USER", tc.envUser)
			hudClaudeCurrentUser = func() (*user.User, error) { return &user.User{Username: tc.username}, tc.userErr }
			var calls [][]string
			hudClaudeSecurityRun = func(_ context.Context, args ...string) ([]byte, error) {
				calls = append(calls, append([]string(nil), args...))
				if len(args) == 6 {
					return tc.scopedData, tc.scopedErr
				}
				return []byte("fallback"), nil
			}
			got, err := hudClaudeKeychainRead(context.Background(), "service")
			if err != nil || string(got) != tc.want {
				t.Fatalf("unexpected result or error: %v", err)
			}
			if !reflect.DeepEqual(calls, tc.wantCalls) {
				t.Fatalf("calls = %v, want %v", calls, tc.wantCalls)
			}
		})
	}
}
