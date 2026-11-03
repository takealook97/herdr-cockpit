package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"time"
)

type hubRPC func(context.Context, string, any) (json.RawMessage, error)

// Document versions make a read/modify/write safe across separate hc sessions.
func hubHCRPC(ctx context.Context, method string, params any) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	path := hudHCPath()
	if path == "" {
		return nil, fmt.Errorf("hc unavailable")
	}
	c := exec.CommandContext(ctx, path, "connect")
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "HC_TERMINAL_ID=") {
			c.Env = append(c.Env, e)
		}
	}
	in, err := c.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := c.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	c.Stderr = &stderr
	if err := c.Start(); err != nil {
		return nil, err
	}
	defer func() { _ = in.Close(); _ = c.Process.Kill(); _ = c.Wait() }()
	if err := json.NewEncoder(in).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params}); err != nil {
		return nil, err
	}
	scanner := bufio.NewScanner(out)
	scanner.Buffer(make([]byte, 4096), 16<<20)
	for scanner.Scan() {
		var reply struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &reply); err != nil {
			return nil, err
		}
		if reply.ID != 1 {
			continue
		}
		if len(reply.Error) > 0 && string(reply.Error) != "null" {
			return nil, fmt.Errorf("hc RPC: %s", reply.Error)
		}
		return reply.Result, nil
	}
	return nil, fmt.Errorf("hc RPC ended without response: %v", scanner.Err())
}

func hubDocTab(doc map[string]any, space, tab string) (map[string]any, error) {
	spaces, _ := doc["spaces"].([]any)
	for _, entry := range spaces {
		s, _ := entry.(map[string]any)
		if s["id"] != space {
			continue
		}
		tabs, _ := s["tabs"].([]any)
		for _, entry := range tabs {
			t, _ := entry.(map[string]any)
			if t["id"] == tab {
				return t, nil
			}
		}
	}
	return nil, fmt.Errorf("hub tab %s not found in space %s", tab, space)
}

func hubLeaves(node any) ([]map[string]any, error) {
	n, ok := node.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("invalid hub tree node")
	}
	if n["type"] == "block" {
		return []map[string]any{n}, nil
	}
	if n["type"] != "row" && n["type"] != "column" {
		return nil, fmt.Errorf("unknown hub tree node type %v", n["type"])
	}
	children, ok := n["children"].([]any)
	if !ok {
		return nil, fmt.Errorf("missing hub tree children")
	}
	var leaves []map[string]any
	for _, child := range children {
		part, err := hubLeaves(child)
		if err != nil {
			return nil, err
		}
		leaves = append(leaves, part...)
	}
	return leaves, nil
}

func hubLeafTerminal(leaf map[string]any) string {
	content, _ := leaf["content"].(map[string]any)
	if _, mod := content["mod"]; mod {
		return ""
	}
	terminal, _ := content["terminal"].(string)
	return terminal
}

// gridTree keeps all blocks (including foreign/mod blocks), ordering known
// terminals first. Every sibling has equal weight; the first row gets the extra.
// Copies protect the caller's leaves from size changes.
func gridTree(leaves []map[string]any, order []string) map[string]any {
	var sorted []map[string]any
	used := make([]bool, len(leaves))
	for _, terminal := range order {
		if terminal == "" {
			continue
		}
		for i, leaf := range leaves {
			if !used[i] && hubLeafTerminal(leaf) == terminal {
				used[i] = true
				sorted = append(sorted, leaf)
			}
		}
	}
	for i, leaf := range leaves {
		if !used[i] {
			sorted = append(sorted, leaf)
		}
	}
	if len(sorted) == 0 {
		return nil
	}
	blocks := make([]any, 0, len(sorted))
	for _, leaf := range sorted {
		copy := map[string]any{}
		for k, v := range leaf {
			copy[k] = v
		}
		if len(sorted) == 1 {
			delete(copy, "size")
		} else {
			copy["size"] = map[string]any{"weight": float64(1)}
		}
		blocks = append(blocks, copy)
	}
	if len(blocks) == 1 {
		return blocks[0].(map[string]any)
	}
	id := fmt.Sprintf("hub-grid-%v", sorted[0]["id"])
	if len(blocks) == 2 {
		return map[string]any{"type": "row", "id": id, "children": blocks}
	}
	cols := (len(blocks) + 1) / 2
	rows := []any{}
	for i, children := range [][]any{blocks[:cols], blocks[cols:]} {
		rows = append(rows, map[string]any{"type": "row", "id": fmt.Sprintf("%s-row-%d", id, i), "size": map[string]any{"weight": float64(1)}, "children": children})
	}
	return map[string]any{"type": "column", "id": id, "children": rows}
}

func hubLayout(ctx context.Context, space, tab string, order []string, rpc hubRPC) (bool, error) {
	for attempt := 0; attempt < 3; attempt++ {
		raw, err := rpc(ctx, "doc.get", map[string]any{"name": "herdr-app"})
		if err != nil {
			return false, err
		}
		var doc struct {
			Value   map[string]any `json:"value"`
			Version int            `json:"version"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			return false, err
		}
		t, err := hubDocTab(doc.Value, space, tab)
		if err != nil {
			return false, err
		}
		leaves, err := hubLeaves(t["root"])
		if err != nil {
			return false, err
		}
		root := gridTree(leaves, order)
		if root == nil || reflect.DeepEqual(root, t["root"]) {
			return false, nil
		}
		t["root"] = root
		_, err = rpc(ctx, "doc.set", map[string]any{"name": "herdr-app", "value": doc.Value, "version": doc.Version})
		if err == nil {
			return true, nil
		}
		if !strings.Contains(strings.ToLower(err.Error()), "conflict") {
			return false, err
		}
	}
	return false, fmt.Errorf("hub layout version conflict after three attempts")
}
