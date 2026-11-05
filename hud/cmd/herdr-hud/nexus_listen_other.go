//go:build !darwin && !linux

package main

import "context"

func nexusListen(ctx context.Context, sub string, expectedPID ...int) any {
	return map[string]any{"state": "unavailable", "level": 0, "partial": "", "final": "", "error": ""}
}
