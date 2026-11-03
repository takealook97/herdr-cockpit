package main

import (
	"os"
	"os/exec"
	"path/filepath"
)

func hudHCPath() string {
	if path, err := exec.LookPath("hc"); err == nil {
		return path
	}
	home, _ := os.UserHomeDir()
	for _, path := range []string{filepath.Join(home, ".local/bin/hc"), filepath.Join(home, ".local/bin/herdr-core"), "/opt/homebrew/bin/hc", "/usr/local/bin/hc"} {
		if info, err := os.Stat(path); err == nil && !info.IsDir() && info.Mode()&0111 != 0 {
			return path
		}
	}
	return ""
}
