package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const (
	linearSourceAPIKey    = "api_key"
	linearSourceClaudeMCP = "claude_mcp"
	linearKeychainService = "herdr-hud-linear"
	linearKeychainAccount = "default"
	linearMCPHost         = "mcp.linear.app"
	linearMCPPreferredURL = "https://mcp.linear.app/mcp"
)

// linearCred carries a resolved credential in memory only. It has no JSON tags
// and redacts itself when formatted, so the secret cannot leak through logs.
type linearCred struct {
	Source     string
	Secret     string
	Generation string
	ServerURL  string
	ExpiresAt  time.Time
}

func (c linearCred) String() string   { return "linearCred{" + c.Source + " <redacted>}" }
func (c linearCred) GoString() string { return c.String() }

// Test seams. Production code never changes these.
var (
	linearGOOS        = runtime.GOOS
	linearSecurityRun = func(ctx context.Context, args ...string) ([]byte, error) {
		return exec.CommandContext(ctx, "security", args...).Output()
	}
	linearClaudeRaw = func(ctx context.Context) ([]byte, error) { return hudClaudeCredentialsRaw(ctx, "") }
)

func linearConfigDir() string {
	root := os.Getenv("XDG_CONFIG_HOME")
	if root == "" {
		home, _ := os.UserHomeDir()
		root = filepath.Join(home, ".config")
	}
	return filepath.Join(root, "herdr-hud")
}

func linearKeyFilePath() string  { return filepath.Join(linearConfigDir(), "linear.json") }
func linearMetaFilePath() string { return filepath.Join(linearConfigDir(), "linear-meta.json") }

func linearKeychainArgs(verb string, extra ...string) []string {
	return append([]string{verb, "-s", linearKeychainService, "-a", linearKeychainAccount}, extra...)
}

// linearAPIKeyLoad returns "" when no herdr-hud key is stored or it cannot be read.
func linearAPIKeyLoad(ctx context.Context) string {
	if linearGOOS == "darwin" {
		out, err := linearSecurityRun(ctx, linearKeychainArgs("find-generic-password", "-w")...)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(out))
	}
	raw, err := os.ReadFile(linearKeyFilePath())
	if err != nil {
		return ""
	}
	var body struct {
		APIKey string `json:"api_key"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return ""
	}
	return strings.TrimSpace(body.APIKey)
}

func linearAPIKeyStore(ctx context.Context, key string) error {
	if linearGOOS == "darwin" {
		_, err := linearSecurityRun(ctx, linearKeychainArgs("add-generic-password", "-U", "-w", key)...)
		return err
	}
	raw, err := json.Marshal(struct {
		APIKey string `json:"api_key"`
	}{key})
	if err != nil {
		return err
	}
	if err := hudWritePrivateFile(linearKeyFilePath(), raw); err != nil {
		return err
	}
	return os.Chmod(linearConfigDir(), 0700)
}

// linearAPIKeyDelete is idempotent: a missing key counts as success.
func linearAPIKeyDelete(ctx context.Context) error {
	if linearGOOS == "darwin" {
		if _, err := linearSecurityRun(ctx, linearKeychainArgs("delete-generic-password")...); err != nil && linearAPIKeyLoad(ctx) != "" {
			return err
		}
		return nil
	}
	return linearRemoveIfPresent(linearKeyFilePath())
}

func linearRemoveIfPresent(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// linearMeta is nonsecret identity recorded at connect time.
type linearMeta struct {
	Generation string `json:"generation"`
	UserName   string `json:"user_name"`
	OrgName    string `json:"org_name"`
	OrgURL     string `json:"org_url"`
}

func linearMetaLoad() (linearMeta, bool) {
	raw, err := os.ReadFile(linearMetaFilePath())
	if err != nil {
		return linearMeta{}, false
	}
	var meta linearMeta
	if json.Unmarshal(raw, &meta) != nil || !strings.HasPrefix(meta.Generation, linearSourceAPIKey+":") {
		return linearMeta{}, false
	}
	return meta, true
}

func linearMetaSave(meta linearMeta) error {
	raw, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	return hudWritePrivateFile(linearMetaFilePath(), raw)
}

func linearNewGeneration() string {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		// A clock-based id still separates generations; it is never security relevant.
		return linearSourceAPIKey + ":t" + time.Now().Format("20060102150405.000000000")
	}
	return linearSourceAPIKey + ":" + hex.EncodeToString(id[:])
}

func linearValidMCPURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.User == nil && strings.EqualFold(u.Hostname(), linearMCPHost) && u.Port() == ""
}

// linearMCPEntry selects the Claude Code Linear MCP OAuth entry. The bool reports
// whether a candidate exists; expiry is reported separately so callers avoid a
// network call with an expired token.
func linearMCPEntry(raw []byte, now time.Time) (cred linearCred, found, expired bool) {
	var body struct {
		MCP map[string]struct {
			ServerURL   string `json:"serverUrl"`
			AccessToken string `json:"accessToken"`
			ExpiresAt   int64  `json:"expiresAt"`
			ClientID    string `json:"clientId"`
		} `json:"mcpOAuth"`
	}
	if len(bytes.TrimSpace(raw)) == 0 || json.Unmarshal(raw, &body) != nil {
		return linearCred{}, false, false
	}
	keys := make([]string, 0, len(body.MCP))
	for key, entry := range body.MCP {
		if entry.AccessToken != "" && linearValidMCPURL(entry.ServerURL) {
			keys = append(keys, key)
		}
	}
	if len(keys) == 0 {
		return linearCred{}, false, false
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := body.MCP[keys[i]], body.MCP[keys[j]]
		if ea, eb := a.ServerURL == linearMCPPreferredURL, b.ServerURL == linearMCPPreferredURL; ea != eb {
			return ea
		}
		if a.ExpiresAt != b.ExpiresAt {
			return a.ExpiresAt > b.ExpiresAt
		}
		return keys[i] < keys[j]
	})
	key := keys[0]
	entry := body.MCP[key]
	cred = linearCred{
		Source:     linearSourceClaudeMCP,
		Secret:     entry.AccessToken,
		Generation: linearSourceClaudeMCP + ":" + key + ":" + entry.ClientID,
		ServerURL:  entry.ServerURL,
	}
	if entry.ExpiresAt > 0 {
		cred.ExpiresAt = time.UnixMilli(entry.ExpiresAt)
		expired = !now.Before(cred.ExpiresAt)
	}
	return cred, true, expired
}

// linearResolve picks the herdr-hud API key first, then the Claude Code MCP
// token. code is "" for a usable credential, else not_connected or expired.
func linearResolve(ctx context.Context, now time.Time) (linearCred, string) {
	if key := linearAPIKeyLoad(ctx); key != "" {
		meta, ok := linearMetaLoad()
		if !ok {
			meta = linearMeta{Generation: linearNewGeneration()}
			if linearMetaSave(meta) != nil {
				// Unsaved generations never match a cache entry, which disables caching safely.
				meta.Generation += "-unsaved"
			}
		}
		return linearCred{Source: linearSourceAPIKey, Secret: key, Generation: meta.Generation}, ""
	}
	raw, _ := linearClaudeRaw(ctx)
	cred, found, expired := linearMCPEntry(raw, now)
	switch {
	case !found:
		return linearCred{}, linearErrNotConnected
	case expired:
		return cred, linearErrExpired
	}
	return cred, ""
}
