package commands

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/elCanosail/elicita-cli/internal/api"
)

func TestCalculatePredictionsAverageInterval(t *testing.T) {
	now := time.Now()
	// Use 3 contracts spaced ~12 months apart so prediction falls within the window.
	contratos := []api.OrgContrato{
		{Organismo: "Red.es", Importe: 1000, Fecha: strPtr(now.AddDate(-1, 0, 0).Format("2006-01-02"))},
		{Organismo: "Red.es", Importe: 1000, Fecha: strPtr(now.AddDate(-2, 0, 0).Format("2006-01-02"))},
		{Organismo: "Red.es", Importe: 1000, Fecha: strPtr(now.AddDate(-3, 0, 0).Format("2006-01-02"))},
	}

	results := calculatePredictions(contratos, 24)
	if len(results) != 1 {
		t.Fatalf("expected 1 prediction, got %d", len(results))
	}

	p := results[0]
	if p.IntervaloPromedioMeses < 11.5 || p.IntervaloPromedioMeses > 12.5 {
		t.Fatalf("expected interval ~12 months, got %v", p.IntervaloPromedioMeses)
	}
	// Next prediction should be in the future but within 24 months.
	parsed, err := time.Parse("2006-01-02", p.ProximaEstimada)
	if err != nil {
		t.Fatalf("invalid predicted date: %v", err)
	}
	if parsed.Before(now) || parsed.After(now.AddDate(0, 24, 0)) {
		t.Fatalf("predicted date %v out of expected future window", p.ProximaEstimada)
	}
}

func TestConfidenceLabel(t *testing.T) {
	cases := []struct {
		n    int
		want string
	}{
		{1, "baja"},
		{2, "baja"},
		{3, "media"},
		{5, "media"},
		{6, "alta"},
		{10, "alta"},
	}
	for _, c := range cases {
		got := confidenceLabel(c.n)
		if got != c.want {
			t.Fatalf("confidenceLabel(%d) = %q, want %q", c.n, got, c.want)
		}
	}
}

func TestPredictExcludesPastPredictions(t *testing.T) {
	now := time.Now()
	contratos := []api.OrgContrato{
		{Organismo: "Org Past", Importe: 1000, Fecha: strPtr(now.AddDate(-2, -6, 0).Format("2006-01-02"))},
		{Organismo: "Org Past", Importe: 1000, Fecha: strPtr(now.AddDate(-1, -6, 0).Format("2006-01-02"))},
	}

	results := calculatePredictions(contratos, 24)
	if len(results) != 0 {
		t.Fatalf("expected 0 predictions in the past, got %d", len(results))
	}
}

func TestPredictFiltersByMonths(t *testing.T) {
	now := time.Now()
	// Contracts at 0, 12, and 24 months ago. Next prediction ~now; should be in the future.
	contratos := []api.OrgContrato{
		{Organismo: "Org A", Importe: 1000, Fecha: strPtr(now.AddDate(0, 0, 0).Format("2006-01-02"))},
		{Organismo: "Org A", Importe: 1000, Fecha: strPtr(now.AddDate(-1, 0, 0).Format("2006-01-02"))},
		{Organismo: "Org A", Importe: 1000, Fecha: strPtr(now.AddDate(-2, 0, 0).Format("2006-01-02"))},
	}

	// With 0 month window (only today), next prediction should be excluded because it must be in the future.
	results := calculatePredictions(contratos, 0)
	if len(results) != 0 {
		t.Fatalf("expected 0 predictions strictly in the future, got %d", len(results))
	}

	// With 6 month window, the ~12 month prediction should be excluded.
	results = calculatePredictions(contratos, 6)
	if len(results) != 0 {
		t.Fatalf("expected 0 predictions within 6 months, got %d", len(results))
	}

	// With 24 month window, prediction ~12 months in the future should be included.
	results = calculatePredictions(contratos, 24)
	if len(results) != 1 {
		t.Fatalf("expected 1 prediction within 24 months, got %d", len(results))
	}
	if results[0].IntervaloPromedioMeses < 11.5 || results[0].IntervaloPromedioMeses > 12.5 {
		t.Fatalf("expected interval ~12 months, got %v", results[0].IntervaloPromedioMeses)
	}
}

func TestPredictMockServerJSON(t *testing.T) {
	now := time.Now()
	lastYear := now.AddDate(-1, 0, 0).Format("2006-01-02")
	twoYearsAgo := now.AddDate(-2, 0, 0).Format("2006-01-02")
	threeYearsAgo := now.AddDate(-3, 0, 0).Format("2006-01-02")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/org/B15044357" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		body := fmt.Sprintf(`{
			"ok": true,
			"nif": "B15044357",
			"nombre": "Test SA",
			"total_contratos": 3,
			"volumen_total": 3000,
			"contratos": [
				{"titulo": "C1", "organismo": "Org X", "importe": 1000, "fecha": %q},
				{"titulo": "C2", "organismo": "Org X", "importe": 1000, "fecha": %q},
				{"titulo": "C3", "organismo": "Org X", "importe": 1000, "fecha": %q}
			],
			"meta": {"took_ms": 1}
		}`, threeYearsAgo, twoYearsAgo, lastYear)
		w.Write([]byte(body))
	}))
	defer srv.Close()

	client := api.New(srv.URL, "")
	// Use 24 month window so the ~12 month prediction is included.
	out := captureStdoutAndStderr(t, func() {
		if err := Predict(client, "B15044357", 24, true); err != nil {
			t.Fatalf("Predict error: %v", err)
		}
	})

	if !strings.Contains(out, `"predicciones"`) {
		t.Fatalf("expected JSON output with predictions, got:\n%s", out)
	}

	var parsed PredictOutput
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("cannot parse JSON output: %v\n%s", err, out)
	}
	if len(parsed.Predicciones) != 1 {
		t.Fatalf("expected 1 prediction, got %d", len(parsed.Predicciones))
	}
	if parsed.Meta.TotalGrupos != 1 {
		t.Fatalf("expected meta.total_grupos 1, got %d", parsed.Meta.TotalGrupos)
	}
}

func TestPredictInsufficientData(t *testing.T) {
	now := time.Now()
	lastYear := now.AddDate(-1, 0, 0).Format("2006-01-02")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		body := fmt.Sprintf(`{
			"ok": true,
			"nif": "B00000001",
			"nombre": "Solo Uno SL",
			"total_contratos": 1,
			"volumen_total": 500,
			"contratos": [
				{"titulo": "C1", "organismo": "Org Y", "importe": 500, "fecha": %q}
			],
			"meta": {"took_ms": 1}
		}`, lastYear)
		w.Write([]byte(body))
	}))
	defer srv.Close()

	client := api.New(srv.URL, "")
	out := captureStdoutAndStderr(t, func() {
		if err := Predict(client, "B00000001", 12, false); err != nil {
			t.Fatalf("Predict error: %v", err)
		}
	})

	if !strings.Contains(out, "Datos insuficientes") {
		t.Fatalf("expected insufficient data message, got:\n%s", out)
	}
}

func captureStdoutAndStderr(t *testing.T, fn func()) string {
	t.Helper()
	oldStdout := os.Stdout
	oldStderr := os.Stderr
	r, w, _ := os.Pipe()
	os.Stdout = w
	os.Stderr = w
	defer func() {
		os.Stdout = oldStdout
		os.Stderr = oldStderr
	}()

	fn()
	w.Close()
	data, _ := io.ReadAll(r)
	return string(data)
}

func strPtr(s string) *string {
	return &s
}
