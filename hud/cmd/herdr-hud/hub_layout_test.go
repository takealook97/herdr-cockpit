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
)

func TestGridTree(t *testing.T) {
	for n := 1; n <= 9; n++ {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			var leaves []map[string]any
			var order []string
			for i := 0; i < n; i++ {
				id := fmt.Sprintf("t%d", i)
				leaves = append(leaves, map[string]any{"type": "block", "id": id, "size": map[string]any{"weight": float64(9)}, "content": map[string]any{"terminal": id}, "keep": "value"})
				order = append([]string{id}, order...)
			}
			before, _ := json.Marshal(leaves)
			root := gridTree(leaves, order)
			all, err := hubLeaves(root)
			if err != nil || len(all) != n {
				t.Fatalf("leaves: %v %v", all, err)
			}
			for i, leaf := range all {
				if hubLeafTerminal(leaf) != order[i] || leaf["keep"] != "value" {
					t.Fatalf("order/content: %v", leaf)
				}
				if n > 1 && !reflect.DeepEqual(leaf["size"], map[string]any{"weight": float64(1)}) {
					t.Fatalf("unequal leaf weight: %v", leaf)
				}
			}
			if n == 1 {
				if root["type"] != "block" || root["size"] != nil {
					t.Fatalf("single block must fill tab: %v", root)
				}
			} else if n == 2 {
				if root["type"] != "row" || len(root["children"].([]any)) != 2 {
					t.Fatalf("two blocks must share one row: %v", root)
				}
			} else {
				rows, ok := root["children"].([]any)
				if root["type"] != "column" || !ok || len(rows) != 2 {
					t.Fatalf("expected two rows: %v", root)
				}
				for i, r := range rows {
					row := r.(map[string]any)
					want := (n + 1) / 2
					if i == 1 {
						want = n / 2
					}
					if row["type"] != "row" || len(row["children"].([]any)) != want || !reflect.DeepEqual(row["size"], map[string]any{"weight": float64(1)}) {
						t.Fatalf("row %d: %v", i, row)
					}
				}
			}
			after, _ := json.Marshal(leaves)
			if !bytes.Equal(before, after) {
				t.Fatal("input leaves mutated")
			}
			if !reflect.DeepEqual(root, gridTree(all, order)) {
				t.Fatal("grid is not idempotent")
			}
		})
	}
}

func hubFixture(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile("testdata/hub_document.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func TestHubDocumentRoundTrip(t *testing.T) {
	doc := hubFixture(t)
	before, _ := json.Marshal(doc["value"])
	sets := 0
	rpc := func(_ context.Context, method string, params any) (json.RawMessage, error) {
		p := params.(map[string]any)
		if p["name"] != "herdr-app" {
			t.Fatalf("wrong document: %v", p)
		}
		if method == "doc.get" {
			return json.Marshal(doc)
		}
		if method != "doc.set" || p["version"] != 17 {
			t.Fatalf("wrong write/version: %s %v", method, p)
		}
		sets++
		doc["value"] = p["value"]
		return json.RawMessage(`{}`), nil
	}
	order := []string{"absent", "o1", "o1"}
	changed, err := hubLayout(context.Background(), "hub", "mirrors", order, rpc)
	if err != nil || !changed || sets != 1 {
		t.Fatalf("first write: %v %v %d", changed, err, sets)
	}
	value := doc["value"].(map[string]any)
	tab, _ := hubDocTab(value, "hub", "mirrors")
	leaves, _ := hubLeaves(tab["root"])
	if len(leaves) != 3 || hubLeafTerminal(leaves[0]) != "o1" || hubLeafTerminal(leaves[1]) != "o2" || leaves[2]["id"] != "mod" {
		t.Fatalf("unknown leaves not retained after ordered ones: %v", leaves)
	}
	changed, err = hubLayout(context.Background(), "hub", "mirrors", order, rpc)
	if err != nil || changed || sets != 1 {
		t.Fatalf("no-op: %v %v %d", changed, err, sets)
	}
	// Restore only the target root: every other field must round-trip unchanged.
	var original map[string]any
	_ = json.Unmarshal(before, &original)
	originalTab, _ := hubDocTab(original, "hub", "mirrors")
	tab["root"] = originalTab["root"]
	after, _ := json.Marshal(value)
	if !bytes.Equal(before, after) {
		t.Fatalf("changed fields outside hub root:\n%s\n%s", before, after)
	}
}

func TestHubLayoutConflicts(t *testing.T) {
	for _, scenario := range []struct {
		name      string
		failures  int
		fatal     bool
		wantSets  int
		wantError bool
	}{{"retry", 1, false, 2, false}, {"exhausted", 3, false, 3, true}, {"fatal", 1, true, 1, true}} {
		t.Run(scenario.name, func(t *testing.T) {
			doc := hubFixture(t)
			sets, gets := 0, 0
			rpc := func(_ context.Context, method string, params any) (json.RawMessage, error) {
				if method == "doc.get" {
					gets++
					return json.Marshal(doc)
				}
				sets++
				p := params.(map[string]any)
				if p["version"] != int(doc["version"].(float64)) {
					t.Fatalf("stale version: %v", p["version"])
				}
				if sets <= scenario.failures {
					if scenario.fatal {
						return nil, errors.New("permission denied")
					}
					doc["version"] = doc["version"].(float64) + 1
					doc["value"].(map[string]any)["concurrent"] = "preserved"
					return nil, errors.New("version conflict")
				}
				if p["value"].(map[string]any)["concurrent"] != "preserved" {
					t.Fatal("retry overwrote concurrent change")
				}
				return json.RawMessage(`{}`), nil
			}
			changed, err := hubLayout(context.Background(), "hub", "mirrors", nil, rpc)
			if (err != nil) != scenario.wantError || changed == scenario.wantError || sets != scenario.wantSets || gets != sets {
				t.Fatalf("changed=%v err=%v gets=%d sets=%d", changed, err, gets, sets)
			}
		})
	}
}

func TestHubLayoutRejectsMissingOrMalformedTab(t *testing.T) {
	for _, raw := range []string{`not json`, `{"value":{}}`, `{"value":{"spaces":[{"id":"hub","tabs":[{"id":"mirrors","root":{"type":"unknown"}}]}]}}`, `{"value":{"spaces":[{"id":"other","tabs":[{"id":"mirrors"}]}]}}`} {
		_, err := hubLayout(context.Background(), "hub", "mirrors", nil, func(_ context.Context, method string, _ any) (json.RawMessage, error) {
			if method != "doc.get" {
				t.Fatal("invalid document caused a write")
			}
			return json.RawMessage(raw), nil
		})
		if err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}

func TestHubLayoutCommandAndRPC(t *testing.T) {
	bin := t.TempDir()
	t.Setenv("PATH", bin)
	t.Setenv("HC_TERMINAL_ID", "must-not-inherit")
	script := `#!/bin/sh
[ "$1" = connect ] || exit 1
[ -z "$HC_TERMINAL_ID" ] || exit 1
read -r request
case "$request" in
  *doc.get*) echo '{"jsonrpc":"2.0","id":1,"result":{"version":1,"value":{"spaces":[{"id":"h","tabs":[{"id":"t","root":{"type":"block","id":"b","content":{"terminal":"o"}}}]}]}}}' ;;
  *) exit 1 ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "hc"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	code := cmdHud([]string{"hub-layout", "--space", "h", "--tab", "t", "--order", "o"}, &out, &stderr)
	if code != 0 || out.String() != "{\"changed\":false}\n" {
		t.Fatalf("%d %s %s", code, out.String(), stderr.String())
	}
	for _, args := range [][]string{{"hub-layout"}, {"hub-layout", "--space", "remote/h", "--tab", "t"}, {"hub-layout", "--space", "h", "--tab", "t", "extra"}} {
		if code := cmdHud(args, &out, &stderr); code != 2 {
			t.Fatalf("invalid args: %v -> %d", args, code)
		}
	}
	out.Reset()
	stderr.Reset()
	code = cmdHud([]string{"hub-layout", "--space", "absent", "--tab", "t"}, &out, &stderr)
	if code != 1 || !strings.Contains(stderr.String(), "not found") {
		t.Fatalf("missing tab: %d %s", code, stderr.String())
	}
}
