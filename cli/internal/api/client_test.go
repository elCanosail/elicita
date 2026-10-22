package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientSearchSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/search" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer testkey" {
			t.Fatalf("unexpected auth header: %s", auth)
		}
		q := r.URL.Query()
		if q.Get("q") != "hospital" {
			t.Fatalf("unexpected query: %v", q.Get("q"))
		}
		resp := SearchResponse{OK: true}
		resp.Results = []SearchResult{
			{Titulo: "Contrato 1", Fuente: "PLACE", NIFAdj: "A12345678"},
		}
		resp.Pagination = Pagination{Limit: 10, Offset: 0, HasMore: false}
		resp.Meta = Meta{TookMs: 5, QueriesRemaining: 100, RateLimitRemaining: 1000, Total: 1}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	client := New(server.URL, "testkey")
	res, err := client.Search(SearchParams{Q: "hospital", Limit: 10})
	if err != nil {
		t.Fatalf("search failed: %v", err)
	}
	if len(res.Results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(res.Results))
	}
	if res.Results[0].Titulo != "Contrato 1" {
		t.Fatalf("unexpected title: %s", res.Results[0].Titulo)
	}
	if res.Meta.Total != 1 {
		t.Fatalf("unexpected total: %d", res.Meta.Total)
	}
}

func TestClientSearchAuthError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "nope"})
	}))
	defer server.Close()

	client := New(server.URL, "badkey")
	_, err := client.Search(SearchParams{Q: "x", Limit: 1})
	if err == nil || !strings.Contains(err.Error(), "unauthorized") {
		t.Fatalf("expected unauthorized error, got: %v", err)
	}
}

func TestClientSearchRateLimit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "slow down"})
	}))
	defer server.Close()

	client := New(server.URL, "key")
	_, err := client.Search(SearchParams{Q: "x", Limit: 1})
	if err == nil || !strings.Contains(err.Error(), "rate limit") {
		t.Fatalf("expected rate limit error, got: %v", err)
	}
}

func TestClientSearchAllPagination(t *testing.T) {
	call := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		limit := 2
		offset := 0
		if v := r.URL.Query().Get("limit"); v != "" {
			limit = parseInt(v)
		}
		if v := r.URL.Query().Get("offset"); v != "" {
			offset = parseInt(v)
		}
		call++
		resp := SearchResponse{OK: true}
		resp.Meta = Meta{Total: 4}
		resp.Pagination = Pagination{Limit: limit, Offset: offset}
		if offset == 0 {
			resp.Results = []SearchResult{{Titulo: "A"}, {Titulo: "B"}}
			resp.Pagination.HasMore = true
		} else {
			resp.Results = []SearchResult{{Titulo: "C"}, {Titulo: "D"}}
			resp.Pagination.HasMore = false
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	client := New(server.URL, "key")
	results, total, err := client.SearchAll(SearchParams{Limit: 2}, 1000, nil)
	if err != nil {
		t.Fatalf("search all failed: %v", err)
	}
	if total != 4 {
		t.Fatalf("expected total 4, got %d", total)
	}
	if len(results) != 4 {
		t.Fatalf("expected 4 results, got %d", len(results))
	}
	if call != 2 {
		t.Fatalf("expected 2 calls, got %d", call)
	}
}

func TestClientGraph(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/graph" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		resp := GraphResponse{
			Nodes: []GraphNode{{ID: "n1", Name: "X", Type: "organismo"}},
			Edges: []GraphEdge{},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	client := New(server.URL, "key")
	res, err := client.Graph("X", "organismo", "", "")
	if err != nil {
		t.Fatalf("graph failed: %v", err)
	}
	if len(res.Nodes) != 1 {
		t.Fatalf("expected 1 node, got %d", len(res.Nodes))
	}
}

func TestClientAlertsRequiresWebAuth(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/alertas" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "No autenticado"})
	}))
	defer server.Close()

	client := New(server.URL, "key")
	_, err := client.GetAlerts()
	if err == nil || !strings.Contains(err.Error(), "unauthorized") {
		t.Fatalf("expected unauthorized error, got: %v", err)
	}
}

func parseInt(s string) int {
	var n int
	for _, ch := range s {
		n = n*10 + int(ch-'0')
	}
	return n
}
