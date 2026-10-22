// Package api provides a minimal HTTP client for the Elicita API v1.
package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client is the Elicita API client.
type Client struct {
	BaseURL    string
	APIKey     string
	HTTPClient *http.Client
}

// New creates a new API client.
func New(baseURL, apiKey string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		APIKey:  apiKey,
		HTTPClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// SearchParams holds all search query parameters.
type SearchParams struct {
	Q          string
	CPV        string
	ImporteMin string
	ImporteMax string
	Estado     string
	Fuente     string
	NIF        string
	Desde      string // year, e.g. "2024"
	Hasta      string // year, e.g. "2026"
	Limit      int
	Offset     int
	Sort       string
	Dir        string
}

// SearchResult is a single row from the search API.
type SearchResult struct {
	Titulo        string   `json:"titulo"`
	Organismo     string   `json:"organismo"`
	Adjudicatario string   `json:"adjudicatario"`
	NIFAdj        string   `json:"nif_adj"`
	Importe       *float64 `json:"importe"`
	CPV           string   `json:"cpv"`
	Estado        string   `json:"estado"`
	Fecha         string   `json:"fecha"`
	Fuente        string   `json:"fuente"`
	URL           string   `json:"url_pub"`
}

// Pagination is part of SearchResponse.
type Pagination struct {
	Limit   int  `json:"limit"`
	Offset  int  `json:"offset"`
	HasMore bool `json:"has_more"`
}

// Meta is part of SearchResponse.
type Meta struct {
	TookMs             int `json:"took_ms"`
	QueriesRemaining   int `json:"queries_remaining"`
	RateLimitRemaining int `json:"rate_limit_remaining"`
	Total              int `json:"total"`
}

// SearchResponse is the full API response from /api/v1/search.
type SearchResponse struct {
	OK    bool `json:"ok"`
	Query struct {
		Q       string                 `json:"q"`
		Filters map[string]interface{} `json:"filters"`
	} `json:"query"`
	Results    []SearchResult `json:"results"`
	Pagination Pagination     `json:"pagination"`
	Meta       Meta           `json:"meta"`
}

// Search calls the /api/v1/search endpoint.
func (c *Client) Search(params SearchParams) (*SearchResponse, error) {
	u, err := url.Parse(c.BaseURL + "/api/v1/search")
	if err != nil {
		return nil, err
	}

	q := u.Query()
	if params.Q != "" {
		q.Set("q", params.Q)
	}
	if params.CPV != "" {
		q.Set("cpv", params.CPV)
	}
	if params.ImporteMin != "" {
		q.Set("importeMin", params.ImporteMin)
	}
	if params.ImporteMax != "" {
		q.Set("importeMax", params.ImporteMax)
	}
	if params.Estado != "" {
		q.Set("estado", params.Estado)
	}
	if params.Fuente != "" {
		q.Set("fuente", params.Fuente)
	}
	if params.NIF != "" {
		q.Set("nif", params.NIF)
	}
	if params.Desde != "" {
		q.Set("desde", params.Desde)
	}
	if params.Hasta != "" {
		q.Set("hasta", params.Hasta)
	}
	if params.Limit > 0 {
		q.Set("limit", strconv.Itoa(params.Limit))
	}
	if params.Offset > 0 {
		q.Set("offset", strconv.Itoa(params.Offset))
	}
	if params.Sort != "" {
		q.Set("sort", params.Sort)
	}
	if params.Dir != "" {
		q.Set("dir", params.Dir)
	}
	u.RawQuery = q.Encode()

	body, err := c.do("GET", u.String(), nil)
	if err != nil {
		return nil, err
	}

	var resp SearchResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("cannot parse response: %w", err)
	}

	return &resp, nil
}

// SearchAll auto-paginates through /api/v1/search results up to maxResults.
func (c *Client) SearchAll(params SearchParams, maxResults int, progress func(current, total int)) ([]SearchResult, int, error) {
	if params.Limit <= 0 {
		params.Limit = 100
	}

	var all []SearchResult
	total := 0
	page := 0
	for {
		params.Offset = page * params.Limit
		resp, err := c.Search(params)
		if err != nil {
			return all, total, err
		}
		if total == 0 && resp.Meta.Total > 0 {
			total = resp.Meta.Total
		}
		if len(resp.Results) == 0 {
			break
		}
		all = append(all, resp.Results...)
		if progress != nil {
			progress(len(all), total)
		}
		if !resp.Pagination.HasMore {
			break
		}
		if len(all) >= maxResults {
			all = all[:maxResults]
			break
		}
		page++
	}

	return all, total, nil
}

// OrgContrato is a contract within OrgResponse.
type OrgContrato struct {
	Titulo     string  `json:"titulo"`
	Organismo  string  `json:"organismo"`
	Importe    float64 `json:"importe"`
	Fecha      *string `json:"fecha"`
	Fuente     string  `json:"fuente"`
	CPV        *string `json:"cpv"`
	Estado     *string `json:"estado"`
	URLPub     *string `json:"url_pub"`
}

// OrgResponse is the response from /api/v1/org/<nif>.
type OrgResponse struct {
	OK            bool          `json:"ok"`
	NIF           string        `json:"nif"`
	Nombre        string        `json:"nombre"`
	TotalContratos int          `json:"total_contratos"`
	VolumenTotal  float64       `json:"volumen_total"`
	Contratos     []OrgContrato `json:"contratos"`
	Borme       *struct {
		Domicilio         *string  `json:"domicilio"`
		CapitalEuros      *float64 `json:"capital_euros"`
		FechaConstitucion *string  `json:"fecha_constitucion"`
		Provincia         *string  `json:"provincia"`
		FechaBorme        *string  `json:"fecha_borme"`
	} `json:"borme,omitempty"`
	Meta struct {
		TookMs int `json:"took_ms"`
	} `json:"meta"`
}

// GetOrg calls GET /api/v1/org/<nif>.
func (c *Client) GetOrg(nif string) (*OrgResponse, error) {
	body, err := c.do("GET", c.BaseURL+"/api/v1/org/"+url.PathEscape(nif), nil)
	if err != nil {
		return nil, err
	}
	var resp OrgResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("cannot parse org response: %w", err)
	}
	return &resp, nil
}

// GraphNode represents a node in the relationship graph.
type GraphNode struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Type      string  `json:"type"` // "organismo" | "adjudicatario"
	Contratos int     `json:"contratos"`
	Volumen   float64 `json:"volumen"`
}

// GraphEdge represents an edge in the relationship graph.
type GraphEdge struct {
	Source    string  `json:"source"`
	Target    string  `json:"target"`
	Contratos int     `json:"contratos"`
	Volumen   float64 `json:"volumen"`
}

// GraphResponse is the response from /api/graph.
type GraphResponse struct {
	Nodes []GraphNode `json:"nodes"`
	Edges []GraphEdge `json:"edges"`
}

// Graph calls the /api/graph endpoint.
func (c *Client) Graph(query, nodeType, cpv, year string) (*GraphResponse, error) {
	u, err := url.Parse(c.BaseURL + "/api/graph")
	if err != nil {
		return nil, err
	}

	q := u.Query()
	if query != "" {
		q.Set("q", query)
	}
	if nodeType != "" {
		q.Set("type", nodeType)
	}
	if cpv != "" {
		q.Set("cpv", cpv)
	}
	if year != "" {
		q.Set("year", year)
	}
	u.RawQuery = q.Encode()

	body, err := c.do("GET", u.String(), nil)
	if err != nil {
		return nil, err
	}

	var resp GraphResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("cannot parse graph response: %w", err)
	}

	return &resp, nil
}

// AlertConfig is the payload for /api/alertas.
type AlertConfig struct {
	CPVs         []string `json:"cpvs"`
	Organismos   []string `json:"organismos"`
	Keywords     []string `json:"keywords"`
	Competidores []string `json:"competidores"`
	Frecuencia   string   `json:"frecuencia"`
	Activo       bool     `json:"activo"`
}

// AlertResponse is the response from /api/alertas.
type AlertResponse struct {
	OK      bool         `json:"ok"`
	Email   string       `json:"email"`
	Alertas *AlertConfig `json:"alertas"`
	Error   string       `json:"error"`
}

// GetAlerts calls GET /api/alertas.
func (c *Client) GetAlerts() (*AlertResponse, error) {
	body, err := c.do("GET", c.BaseURL+"/api/alertas", nil)
	if err != nil {
		return nil, err
	}
	var resp AlertResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("cannot parse alerts response: %w", err)
	}
	return &resp, nil
}

// SaveAlerts calls POST /api/alertas.
func (c *Client) SaveAlerts(cfg AlertConfig) (*AlertResponse, error) {
	data, err := json.Marshal(cfg)
	if err != nil {
		return nil, err
	}
	body, err := c.do("POST", c.BaseURL+"/api/alertas", data)
	if err != nil {
		return nil, err
	}
	var resp AlertResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("cannot parse alerts response: %w", err)
	}
	return &resp, nil
}

// do performs an HTTP request with proper authentication.
func (c *Client) do(method, url string, body []byte) ([]byte, error) {
	var bodyReader io.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	}

	req, err := http.NewRequest(method, url, bodyReader)
	if err != nil {
		return nil, err
	}

	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "elicitac/0.3.0")
	if method == "POST" && body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("cannot read response: %w", err)
	}

	if resp.StatusCode == 401 {
		return nil, fmt.Errorf("unauthorized — run 'elicitac auth' to set your API key")
	}
	if resp.StatusCode == 403 {
		return nil, fmt.Errorf("forbidden — API access requires Enterprise plan")
	}
	if resp.StatusCode == 429 {
		return nil, fmt.Errorf("rate limit exceeded — slow down")
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("API error (HTTP %d): %s", resp.StatusCode, string(data))
	}

	return data, nil
}
