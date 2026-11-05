//go:build darwin || linux

package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestNexusListenUnavailable(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		for _, sub := range []string{"start", "stop", "status"} {
			got := nexusListenWith(context.Background(), sub, goos, filepath.Join(t.TempDir(), "missing"), t.TempDir())
			if got.State != "unavailable" {
				t.Fatal(got)
			}
		}
	}
}
func TestNexusListenStatus(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "herdr-listen")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\n"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ raw, want string }{{`{"state":"final","final":"hello"}`, "final"}, {`{"state":"listening","pid":99999999}`, "error"}, {`{"state":"invalid"}`, "error"}, {`{`, "error"}} {
		if err := os.WriteFile(filepath.Join(dir, "listen.json"), []byte(tc.raw), 0600); err != nil {
			t.Fatal(err)
		}
		got := nexusListenWith(context.Background(), "status", "darwin", binary, dir)
		if got.State != tc.want {
			t.Fatal(got)
		}
	}
}
