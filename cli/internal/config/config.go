// Package config manages the CLI configuration file (~/.elicitac/config.json)
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const (
	ConfigDir  = ".elicitac"
	ConfigFile = "config.json"
)

// Config holds the CLI configuration persisted between runs.
type Config struct {
	APIKey   string `json:"api_key,omitempty"`
	Endpoint string `json:"endpoint,omitempty"`
}

// Default returns a config with sensible defaults.
func Default() *Config {
	return &Config{
		Endpoint: "https://elicita.es",
	}
}

// Path returns the full path to the config file.
func Path() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot find home directory: %w", err)
	}
	return filepath.Join(home, ConfigDir, ConfigFile), nil
}

// Load reads the config from disk, falling back to defaults.
func Load() (*Config, error) {
	p, err := Path()
	if err != nil {
		return Default(), nil
	}

	data, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return Default(), nil
		}
		return nil, fmt.Errorf("cannot read config: %w", err)
	}

	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("invalid config format: %w", err)
	}

	// Apply defaults
	if c.Endpoint == "" {
		c.Endpoint = "https://elicita.es"
	}

	return &c, nil
}

// Save writes the config to disk.
func Save(c *Config) error {
	p, err := Path()
	if err != nil {
		return err
	}

	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("cannot create config directory: %w", err)
	}

	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}

	if err := os.WriteFile(p, data, 0600); err != nil {
		return fmt.Errorf("cannot write config: %w", err)
	}

	return nil
}