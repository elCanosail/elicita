package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestInitialize(t *testing.T) {
	in := strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}` + "\n")
	out := new(bytes.Buffer)

	if err := run(in, out); err != nil {
		t.Fatalf("run failed: %v", err)
	}

	var resp jsonrpcMessage
	if err := json.Unmarshal(out.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if resp.Method != "" {
		t.Fatalf("expected response, got request: %v", resp)
	}

	var result struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("result unmarshal failed: %v", err)
	}
	if result.ProtocolVersion == "" {
		t.Fatal("expected protocol version")
	}
}

func TestToolsList(t *testing.T) {
	in := strings.NewReader(`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}` + "\n")
	out := new(bytes.Buffer)

	if err := run(in, out); err != nil {
		t.Fatalf("run failed: %v", err)
	}

	var resp jsonrpcMessage
	if err := json.Unmarshal(out.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	var result struct {
		Tools []mcpTool `json:"tools"`
	}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("result unmarshal failed: %v", err)
	}
	if len(result.Tools) != 4 {
		t.Fatalf("expected 4 tools, got %d", len(result.Tools))
	}
}
