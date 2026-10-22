// elicitac-mcp — MCP server wrapper for the Elicita CLI.
// Implements the Model Context Protocol over stdio (JSON-RPC 2.0).
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/elCanosail/elicita-cli/internal/api"
	"github.com/elCanosail/elicita-cli/internal/config"
)

const version = "0.3.0"

// jsonrpcMessage is a generic JSON-RPC 2.0 message.
type jsonrpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *jsonrpcError   `json:"error,omitempty"`
}

type jsonrpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// mcpTool describes an exposed MCP tool.
type mcpTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

var tools = []mcpTool{
	{
		Name:        "elicitac_search",
		Description: "Search Spanish public procurement records (66.4M+ records).",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"q":      map[string]string{"type": "string", "description": "Free-text search query"},
				"cpv":    map[string]string{"type": "string", "description": "CPV code prefix"},
				"nif":    map[string]string{"type": "string", "description": "Adjudicatario NIF"},
				"estado": map[string]string{"type": "string", "description": "Contract status"},
				"fuente": map[string]string{"type": "string", "description": "Source (PLACE, TED, Andalucía, ...)"},
				"desde":  map[string]string{"type": "string", "description": "From year (YYYY)"},
				"hasta":  map[string]string{"type": "string", "description": "To year (YYYY)"},
				"min":    map[string]string{"type": "string", "description": "Minimum amount (euros)"},
				"max":    map[string]string{"type": "string", "description": "Maximum amount (euros)"},
				"limit":  map[string]string{"type": "integer", "description": "Max results (default 20, max 100)"},
				"offset": map[string]string{"type": "integer", "description": "Pagination offset"},
				"sort":   map[string]string{"type": "string", "description": "Sort column"},
				"dir":    map[string]string{"type": "string", "description": "Sort direction (asc, desc)"},
			},
		},
	},
	{
		Name:        "elicitac_org",
		Description: "Get company/organism profile by NIF.",
		InputSchema: map[string]any{
			"type": "object",
			"required": []string{"nif"},
			"properties": map[string]any{
				"nif": map[string]string{"type": "string", "description": "Company NIF"},
			},
		},
	},
	{
		Name:        "elicitac_stats",
		Description: "Quick statistics for the current filters.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"cpv":    map[string]string{"type": "string", "description": "Filter by CPV"},
				"fuente": map[string]string{"type": "string", "description": "Filter by source"},
				"year":   map[string]string{"type": "string", "description": "Filter by year"},
			},
		},
	},
	{
		Name:        "elicitac_predict",
		Description: "Predict future contract volume for a company (placeholder implementation).",
		InputSchema: map[string]any{
			"type": "object",
			"required": []string{"nif"},
			"properties": map[string]any{
				"nif":    map[string]string{"type": "string", "description": "Company NIF"},
				"months": map[string]string{"type": "integer", "description": "Forecast horizon in months (default 12)"},
			},
		},
	},
}

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "mcp server error: %v\n", err)
		os.Exit(1)
	}
}

func run(in io.Reader, out io.Writer) error {
	scanner := bufio.NewScanner(in)
	encoder := json.NewEncoder(out)
	// Disable HTML escaping and add a trailing newline per message.
	encoder.SetEscapeHTML(false)

	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}

		var msg jsonrpcMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			_ = replyError(encoder, nil, -32700, "Parse error", err.Error())
			continue
		}

		if msg.JSONRPC != "" && msg.JSONRPC != "2.0" {
			_ = replyError(encoder, msg.ID, -32600, "Invalid Request", "jsonrpc version must be 2.0")
			continue
		}

		result, err := handleMethod(msg.Method, msg.Params)
		if err != nil {
			_ = replyError(encoder, msg.ID, err.Code, err.Message, err.Data)
			continue
		}

		resp := jsonrpcMessage{
			JSONRPC: "2.0",
			ID:      msg.ID,
			Result:  result,
		}
		if err := encoder.Encode(resp); err != nil {
			return err
		}
	}

	return scanner.Err()
}

func handleMethod(method string, params json.RawMessage) (json.RawMessage, *jsonrpcError) {
	switch method {
	case "initialize":
		return marshalResult(map[string]any{
			"protocolVersion": "2024-11-05",
			"serverInfo": map[string]string{
				"name":    "elicitac-mcp",
				"version": version,
			},
			"capabilities": map[string]any{},
		})
	case "tools/list":
		return marshalResult(map[string]any{"tools": tools})
	case "tools/call":
		return handleToolCall(params)
	default:
		return nil, &jsonrpcError{Code: -32601, Message: "Method not found"}
	}
}

func handleToolCall(params json.RawMessage) (json.RawMessage, *jsonrpcError) {
	var call struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(params, &call); err != nil {
		return nil, &jsonrpcError{Code: -32602, Message: "Invalid params", Data: err.Error()}
	}

	cfg, err := config.Load()
	if err != nil {
		return nil, &jsonrpcError{Code: -32000, Message: "Config error", Data: err.Error()}
	}
	client := api.New(cfg.Endpoint, cfg.APIKey)

	var result any
	var callErr error

	switch call.Name {
	case "elicitac_search":
		p := parseSearchArgs(call.Arguments)
		result, callErr = client.Search(p)
	case "elicitac_org":
		nif := getString(call.Arguments, "nif")
		if nif == "" {
			return nil, &jsonrpcError{Code: -32602, Message: "Missing required argument: nif"}
		}
		result, callErr = client.GetOrg(nif)
	case "elicitac_stats":
		p, cpv, fuente, year := parseStatsArgs(call.Arguments)
		result, callErr = fetchStats(client, p, cpv, fuente, year)
	case "elicitac_predict":
		nif := getString(call.Arguments, "nif")
		if nif == "" {
			return nil, &jsonrpcError{Code: -32602, Message: "Missing required argument: nif"}
		}
		months := getInt(call.Arguments, "months", 12)
		result, callErr = predict(client, nif, months)
	default:
		return nil, &jsonrpcError{Code: -32601, Message: "Tool not found", Data: call.Name}
	}

	if callErr != nil {
		return nil, &jsonrpcError{Code: -32000, Message: callErr.Error()}
	}

	return marshalResult(map[string]any{
		"content": []map[string]any{
			{
				"type": "text",
				"text": mustMarshalText(result),
			},
		},
		"isError": false,
	})
}

func parseSearchArgs(raw json.RawMessage) api.SearchParams {
	p := api.SearchParams{}
	p.Q = getString(raw, "q")
	p.CPV = getString(raw, "cpv")
	p.NIF = getString(raw, "nif")
	p.Estado = getString(raw, "estado")
	p.Fuente = getString(raw, "fuente")
	p.Desde = getString(raw, "desde")
	p.Hasta = getString(raw, "hasta")
	p.ImporteMin = getString(raw, "min")
	p.ImporteMax = getString(raw, "max")
	p.Limit = getInt(raw, "limit", 20)
	p.Offset = getInt(raw, "offset", 0)
	p.Sort = getString(raw, "sort")
	p.Dir = getString(raw, "dir")
	if p.Dir == "" {
		p.Dir = "desc"
	}
	return p
}

func parseStatsArgs(raw json.RawMessage) (api.SearchParams, string, string, string) {
	cpv := getString(raw, "cpv")
	fuente := getString(raw, "fuente")
	year := getString(raw, "year")
	p := api.SearchParams{CPV: cpv, Fuente: fuente}
	if year != "" {
		p.Desde = year
		p.Hasta = year
	}
	return p, cpv, fuente, year
}

func fetchStats(client *api.Client, params api.SearchParams, cpv, fuente, year string) (map[string]any, error) {
	totalParams := params
	totalParams.Limit = 1
	resp, err := client.Search(totalParams)
	if err != nil {
		return nil, err
	}
	total := resp.Meta.Total
	if total == 0 {
		total = len(resp.Results)
	}

	fuentes := []string{"PLACE", "TED", "Andalucía", "Galicia", "Euskadi", "Madrid", "Catalunya"}
	porFuente := make(map[string]int)
	for _, f := range fuentes {
		porFuente[f] = 0
	}
	for _, f := range fuentes {
		fp := params
		fp.Fuente = f
		fp.Limit = 1
		fresp, err := client.Search(fp)
		if err != nil {
			continue
		}
		count := fresp.Meta.Total
		if count == 0 {
			count = len(fresp.Results)
		}
		porFuente[f] = count
	}

	return map[string]any{
		"total":      total,
		"por_fuente": porFuente,
		"filtros": map[string]string{
			"cpv":    cpv,
			"fuente": fuente,
			"year":   year,
		},
	}, nil
}

func predict(client *api.Client, nif string, months int) (map[string]any, error) {
	resp, err := client.GetOrg(nif)
	if err != nil {
		return nil, err
	}
	if !resp.OK {
		return map[string]any{
			"nif":     nif,
			"months":  months,
			"warning": "no historical data found",
			"forecast": []map[string]any{},
		}, nil
	}

	if months <= 0 {
		months = 12
	}

	avg := 0.0
	if resp.TotalContratos > 0 {
		avg = resp.VolumenTotal / float64(resp.TotalContratos)
	}
	monthly := avg / 12.0

	forecast := make([]map[string]any, months)
	for i := 0; i < months; i++ {
		forecast[i] = map[string]any{
			"month":  i + 1,
			"volume": monthly,
			"lower":  monthly * 0.7,
			"upper":  monthly * 1.3,
		}
	}

	return map[string]any{
		"nif":             nif,
		"months":          months,
		"total_historico": resp.TotalContratos,
		"volumen_total":   resp.VolumenTotal,
		"forecast":        forecast,
		"nota":            "Forecast is a naive projection based on historical average contract value.",
	}, nil
}

func getString(raw json.RawMessage, key string) string {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return ""
	}
	v, ok := m[key]
	if !ok {
		return ""
	}
	s, ok := v.(string)
	if !ok {
		// Try converting numbers/floats to string.
		switch n := v.(type) {
		case float64:
			return strconv.FormatFloat(n, 'f', -1, 64)
		case json.Number:
			return n.String()
		}
		return ""
	}
	return s
}

func getInt(raw json.RawMessage, key string, defaultVal int) int {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return defaultVal
	}
	v, ok := m[key]
	if !ok {
		return defaultVal
	}
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	case json.Number:
		i, err := n.Int64()
		if err != nil {
			return defaultVal
		}
		return int(i)
	case string:
		i, err := strconv.Atoi(n)
		if err != nil {
			return defaultVal
		}
		return i
	}
	return defaultVal
}

func mustMarshalText(v any) string {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		data, _ = json.Marshal(map[string]string{"error": err.Error()})
	}
	return string(data)
}

func replyError(enc *json.Encoder, id json.RawMessage, code int, message string, data any) error {
	resp := jsonrpcMessage{
		JSONRPC: "2.0",
		ID:      id,
		Error: &jsonrpcError{
			Code:    code,
			Message: message,
			Data:    data,
		},
	}
	return enc.Encode(resp)
}

func marshalResult(v any) (json.RawMessage, *jsonrpcError) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, &jsonrpcError{Code: -32603, Message: "Internal error", Data: err.Error()}
	}
	return data, nil
}
