package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveLoadRoundtrip(t *testing.T) {
	dir := t.TempDir()
	oldHome := os.Getenv("HOME")
	os.Setenv("HOME", dir)
	defer os.Setenv("HOME", oldHome)

	cfg := &Config{
		APIKey:   "elc_testkey",
		Endpoint: "https://test.elicita.es",
	}
	if err := Save(cfg); err != nil {
		t.Fatalf("save failed: %v", err)
	}

	p, err := Path()
	if err != nil {
		t.Fatalf("path failed: %v", err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("config file not created: %v", err)
	}

	loaded, err := Load()
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if loaded.APIKey != cfg.APIKey {
		t.Fatalf("api key mismatch: %q vs %q", loaded.APIKey, cfg.APIKey)
	}
	if loaded.Endpoint != cfg.Endpoint {
		t.Fatalf("endpoint mismatch: %q vs %q", loaded.Endpoint, cfg.Endpoint)
	}
}

func TestLoadMissingUsesDefaults(t *testing.T) {
	dir := t.TempDir()
	oldHome := os.Getenv("HOME")
	os.Setenv("HOME", dir)
	defer os.Setenv("HOME", oldHome)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if cfg.Endpoint != "https://elicita.es" {
		t.Fatalf("unexpected default endpoint: %q", cfg.Endpoint)
	}
	if cfg.APIKey != "" {
		t.Fatalf("expected empty api key, got %q", cfg.APIKey)
	}
}

func TestPathPermission(t *testing.T) {
	dir := t.TempDir()
	oldHome := os.Getenv("HOME")
	os.Setenv("HOME", dir)
	defer os.Setenv("HOME", oldHome)

	_ = Save(&Config{APIKey: "x"})
	p, _ := Path()
	info, err := os.Stat(p)
	if err != nil {
		t.Fatalf("stat failed: %v", err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("expected 0600, got %o", info.Mode().Perm())
	}

	dirPath := filepath.Dir(p)
	dInfo, err := os.Stat(dirPath)
	if err != nil {
		t.Fatalf("stat dir failed: %v", err)
	}
	if dInfo.Mode().Perm() != 0700 {
		t.Fatalf("expected 0700 dir, got %o", dInfo.Mode().Perm())
	}
}
