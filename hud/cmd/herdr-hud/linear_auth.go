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
	"strconv"
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
	// linearKeychainNotFound is the security(1) exit status for a missing item.
	linearKeychainNotFound = 44
	linearStatusLockWait   = 5 * time.Second
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
	linearClaudeRaw = linearClaudeCredentialsRaw
)

// linearClaudeCredentialsRaw reads the Claude Code credential for the Linear
// path: the default keychain item, else ${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json.
// It never refreshes, rewrites or deletes the credential.
func linearClaudeCredentialsRaw(ctx context.Context) ([]byte, error) {
	if linearGOOS == "darwin" {
		if raw, _ := hudClaudeKeychainRead(ctx, hudClaudeKeychainService); len(raw) > 0 {
			return raw, nil
		}
	}
	dir := os.Getenv("CLAUDE_CONFIG_DIR")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".claude")
	}
	return os.ReadFile(filepath.Join(dir, ".credentials.json"))
}

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

// linearKeychainMissing reports whether security(1) failed because the item
// does not exist; any other failure must not be mistaken for "no key".
func linearKeychainMissing(err error) bool {
	var exit interface{ ExitCode() int }
	return errors.As(err, &exit) && exit.ExitCode() == linearKeychainNotFound
}

// linearStoredKey is the single store item: the API key and the generation it
// was connected with. Keeping both in one value means a key can never be paired
// with another key's generation. It redacts itself when formatted.
type linearStoredKey struct {
	V          int    `json:"v"`
	APIKey     string `json:"api_key"`
	Generation string `json:"generation"`
}

const linearStoreVersion = 1

func (k linearStoredKey) String() string   { return "linearStoredKey{" + k.Generation + " <redacted>}" }
func (k linearStoredKey) GoString() string { return k.String() }

var errLinearStoreMalformed = errors.New("linear store item malformed")

func linearParseStoredKey(raw []byte) (linearStoredKey, error) {
	var item linearStoredKey
	if json.Unmarshal(bytes.TrimSpace(raw), &item) != nil || item.V != linearStoreVersion ||
		!linearValidKey(item.APIKey) || !strings.HasPrefix(item.Generation, linearSourceAPIKey+":") {
		return linearStoredKey{}, errLinearStoreMalformed
	}
	return item, nil
}

// linearStoreLoad reports found=false with a nil error when no herdr-hud item
// is stored, and an error when the store cannot be read or holds a malformed item.
func linearStoreLoad(ctx context.Context) (linearStoredKey, bool, error) {
	var raw []byte
	var err error
	if linearGOOS == "darwin" {
		raw, err = linearSecurityRun(ctx, linearKeychainArgs("find-generic-password", "-w")...)
		if linearKeychainMissing(err) {
			return linearStoredKey{}, false, nil
		}
	} else {
		raw, err = os.ReadFile(linearKeyFilePath())
		if errors.Is(err, os.ErrNotExist) {
			return linearStoredKey{}, false, nil
		}
	}
	if err != nil {
		return linearStoredKey{}, false, err
	}
	item, err := linearParseStoredKey(raw)
	if err != nil {
		return linearStoredKey{}, false, err
	}
	return item, true, nil
}

// linearStoreWrite replaces the store item in one write.
func linearStoreWrite(ctx context.Context, item linearStoredKey) error {
	raw, err := json.Marshal(item)
	if err != nil {
		return err
	}
	if linearGOOS == "darwin" {
		_, err = linearSecurityRun(ctx, linearKeychainArgs("add-generic-password", "-U", "-w", string(raw))...)
		return err
	}
	if err := hudWritePrivateFile(linearKeyFilePath(), raw); err != nil {
		return err
	}
	return os.Chmod(linearConfigDir(), 0700)
}

// linearStoreDelete is idempotent: a missing item counts as success.
func linearStoreDelete(ctx context.Context) error {
	if linearGOOS == "darwin" {
		if _, err := linearSecurityRun(ctx, linearKeychainArgs("delete-generic-password")...); err != nil && !linearKeychainMissing(err) {
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

// linearMeta is display-only identity recorded at connect time. It is shown
// only when its generation equals the store item's generation.
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

// linearCredentialLock serializes credential mutations with every reader that
// pairs a key with its generation. Holding it is mandatory: readers that cannot
// acquire it report busy instead of reading credentials or writing meta.
func linearCredentialLock(ctx context.Context) (func(), error) {
	return hudLockFile(ctx, filepath.Join(linearConfigDir(), "linear-credential"))
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
		Generation: linearSourceClaudeMCP + ":" + key + ":" + entry.ClientID + ":" + strconv.FormatInt(entry.ExpiresAt, 10),
		ServerURL:  entry.ServerURL,
	}
	if entry.ExpiresAt > 0 {
		cred.ExpiresAt = time.UnixMilli(entry.ExpiresAt)
		expired = !now.Before(cred.ExpiresAt)
	}
	return cred, true, expired
}

// linearResolve picks the herdr-hud API key first, then the Claude Code MCP
// token. code is "" for a usable credential, else not_connected, expired, or
// store_failed when the herdr-hud store cannot be read. The API key's generation
// comes only from its store item. Callers hold the credential lock.
func linearResolve(ctx context.Context, now time.Time) (linearCred, string) {
	item, found, err := linearStoreLoad(ctx)
	if err != nil {
		// Falling through to the MCP token would silently switch accounts.
		return linearCred{}, linearErrStoreFailed
	}
	if found {
		return linearCred{Source: linearSourceAPIKey, Secret: item.APIKey, Generation: item.Generation}, ""
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
