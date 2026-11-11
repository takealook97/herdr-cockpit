package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestHUDClaudeCLIVersionDetection(t *testing.T) {
	for _, tt := range []struct {
		name     string
		versions []string
		target   string
		want     string
	}{
		{"symlink prefers installed CLI", []string{"2.1.99", "2.1.321"}, "2.1.99", "2.1.99"},
		{"nested executable", []string{"2.1.99/claude", "2.1.321"}, "2.1.99/claude", "2.1.99"},
		{"numeric patch", []string{"2.1.99", "2.1.321", "invalid"}, "", "2.1.321"},
		{"numeric minor", []string{"2.9.999", "2.10.1"}, "", "2.10.1"},
		{"numeric major", []string{"9.99.999", "10.0.0"}, "", "10.0.0"},
		{"missing", nil, "", "2.1.321"},
		{"unversioned CLI falls back to installs", []string{"2.2.0"}, "unversioned", "2.2.0"},
		{"broken symlink falls back to installs", []string{"2.2.0"}, "missing", "2.2.0"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			home := t.TempDir()
			versions := filepath.Join(home, ".local", "share", "claude", "versions")
			for _, version := range tt.versions {
				path := filepath.Join(versions, version)
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				// A detected CLI must never be executed, even if executable.
				if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 99\n"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			link := filepath.Join(home, "claude")
			if tt.target != "" {
				target := filepath.Join(versions, tt.target)
				if tt.target == "unversioned" {
					target = filepath.Join(home, "node", "claude")
					if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(target, nil, 0700); err != nil {
						t.Fatal(err)
					}
				}
				if err := os.Symlink(target, link); err != nil {
					t.Fatal(err)
				}
			}
			lookPath := func(name string) (string, error) {
				if name != "claude" {
					t.Fatalf("unexpected lookup %q", name)
				}
				if tt.target == "" {
					return "", errors.New("not found")
				}
				return link, nil
			}
			if got := hudDetectClaudeCLIVersion(home, lookPath); got != tt.want {
				t.Fatalf("version=%q want=%q", got, tt.want)
			}
		})
	}
}

func TestHUDClaudeGrantExpiration(t *testing.T) {
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	for _, tt := range []struct {
		name, endsAt string
		included     bool
		expiry       string
	}{
		{"expired", "2026-11-11T11:59:59Z", false, ""},
		{"expired offset", "2026-11-11T12:59:59+01:00", false, ""},
		{"equal", "2026-11-11T12:00:00Z", true, "2026-11-11T12:00:00Z"},
		{"future", "2026-11-11T13:00:01+01:00", true, "2026-11-11T12:00:01Z"},
		{"invalid", "bad", true, ""},
		{"empty", "", true, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			raw := []byte(`{"seven_day":{"utilization":34},"cedar_ember":{"grants":[{"label":"Reset","resets_left":2,"ends_at":"` + tt.endsAt + `"}]}}`)
			a, err := hudParseClaudeAt(raw, now)
			if err != nil {
				t.Fatal(err)
			}
			want := &HUDCoupons{Items: []HUDCoupon{}}
			if tt.included {
				want = &HUDCoupons{Available: 2, NextExpiresAt: tt.expiry, Items: []HUDCoupon{{"Reset", tt.expiry}}}
			}
			if !reflect.DeepEqual(a.Coupons, want) {
				t.Fatalf("coupons=%+v want=%+v", a.Coupons, want)
			}
		})
	}
}

func TestHUDCouponNextExpirySkipsEmpty(t *testing.T) {
	c := &HUDCoupons{NextExpiresAt: "stale", Items: []HUDCoupon{{"Later", "2027-01-01T00:00:00Z"}, {"Unknown", ""}, {"Soon", "2026-12-01T00:00:00Z"}}}
	hudSortCoupons(c)
	if c.NextExpiresAt != "2026-12-01T00:00:00Z" {
		t.Fatalf("next expiry=%q", c.NextExpiresAt)
	}
	c.Items = []HUDCoupon{{"Unknown", ""}}
	hudSortCoupons(c)
	if c.NextExpiresAt != "" {
		t.Fatalf("unknown expiry=%q", c.NextExpiresAt)
	}
	c.Items = nil
	c.NextExpiresAt = "stale"
	hudSortCoupons(c)
	if c.NextExpiresAt != "" {
		t.Fatalf("empty expiry=%q", c.NextExpiresAt)
	}

	a, err := hudParseClaudeAt([]byte(`{"seven_day":{"utilization":34},"cedar_ember":{"grants":[{"resets_left":1,"ends_at":"bad"},{"resets_left":1,"ends_at":"2026-12-01T00:00:00Z"}]}}`), time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC))
	if err != nil || a.Coupons.NextExpiresAt != "2026-12-01T00:00:00Z" {
		t.Fatalf("Claude coupons=%+v err=%v", a.Coupons, err)
	}
	a, err = hudParseCodex([]byte(`{"rateLimitResetCredits":{"availableCount":2,"credits":[{"status":"available","expiresAt":0},{"status":"available","expiresAt":1796068561}]}}`))
	if err != nil || a.Coupons == nil || a.Coupons.NextExpiresAt != hudUnixDate(1796068561) {
		t.Fatalf("Codex coupons=%+v err=%v", a.Coupons, err)
	}
}
