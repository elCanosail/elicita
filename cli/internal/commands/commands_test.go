package commands

import (
	"bytes"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/elCanosail/elicita-cli/internal/api"
)

func TestTruncate(t *testing.T) {
	cases := []struct {
		in   string
		max  int
		want string
	}{
		{"hello", 10, "hello"},
		{"hello world", 5, "hell…"},
		{"", 5, ""},
		{"ab", 2, "ab"},
	}
	for _, c := range cases {
		got := truncate(c.in, c.max)
		if got != c.want {
			t.Fatalf("truncate(%q, %d) = %q, want %q", c.in, c.max, got, c.want)
		}
	}
}

func TestPrintResultsTable(t *testing.T) {
	old := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	// restore on exit
	defer func() { os.Stdout = old }()

	// Call through Search with a minimal mock not practical without client.
	// Instead directly test the helper by calling printResultsTable.
	printResultsTable([]api.SearchResult{
		{Fuente: "PLACE", Titulo: "Mantenimiento", Organismo: "Ayuntamiento", Adjudicatario: "ACME", Importe: ptr(1234.56), Fecha: "2024-01-15T00:00:00", CPV: "50000000"},
	})

	w.Close()
	os.Stdout = old
	out, _ := io.ReadAll(r)
	s := string(out)
	if !strings.Contains(s, "Mantenimiento") {
		t.Fatalf("expected output to contain 'Mantenimiento', got:\n%s", s)
	}
	if !strings.Contains(s, "1.235€") && !strings.Contains(s, "1235€") {
		t.Fatalf("expected output to contain formatted importe, got:\n%s", s)
	}
}

func ptr(f float64) *float64 {
	return &f
}

func TestAuthRequiresKey(t *testing.T) {
	// Capture stderr because Auth writes to stderr.
	oldStderr := os.Stderr
	r, w, _ := os.Pipe()
	os.Stderr = w
	defer func() { os.Stderr = oldStderr }()

	// Empty key should error.
	err := Auth("", "")
	w.Close()
	os.Stderr = oldStderr
	_, _ = io.Copy(&bytes.Buffer{}, r)

	if err == nil {
		t.Fatal("expected error for empty API key")
	}
}

func TestSplitNonEmpty(t *testing.T) {
	got := splitNonEmpty("a, b,,c", ",")
	want := []string{"a", "b", "c"}
	if len(got) != len(want) {
		t.Fatalf("splitNonEmpty: got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("splitNonEmpty: got %v, want %v", got, want)
		}
	}
	if splitNonEmpty("", ",") != nil {
		t.Fatal("splitNonEmpty of empty string should be nil")
	}
}
