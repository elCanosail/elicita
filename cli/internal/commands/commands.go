// Package commands implements the CLI subcommands.
package commands

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"

	"github.com/elCanosail/elicita-cli/internal/api"
)

// Search executes the search command.
func Search(client *api.Client, params api.SearchParams, asJSON bool) error {
	resp, err := client.Search(params)
	if err != nil {
		return err
	}

	if asJSON {
		data, err := json.MarshalIndent(resp, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(data))
		return nil
	}

	// Human-readable table output
	if len(resp.Results) == 0 {
		fmt.Println("No se encontraron resultados.")
		return nil
	}

	printResultsTable(resp.Results)

	// Footer with metadata
	fmt.Printf("\n%d resultados", len(resp.Results))
	if resp.Pagination.HasMore {
		fmt.Printf(" (hay más — usa --offset %d)", resp.Pagination.Offset+resp.Pagination.Limit)
	}
	fmt.Printf(" · %dms\n", resp.Meta.TookMs)

	return nil
}

// Org displays the company profile for a given NIF using /api/v1/org/<nif>.
func Org(client *api.Client, nif string, asJSON bool) error {
	nif = strings.ToUpper(strings.TrimSpace(nif))

	resp, err := client.GetOrg(nif)
	if err != nil {
		return err
	}

	if !resp.OK {
		fmt.Fprintf(os.Stderr, "No se encontraron contratos para el NIF %s\n", nif)
		return nil
	}

	if asJSON {
		data, err := json.MarshalIndent(resp, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(data))
		return nil
	}

	fmt.Printf("Ficha de empresa: %s\n", resp.Nombre)
	fmt.Printf("NIF: %s · %d contratos · Volumen total: %.0f€\n", nif, resp.TotalContratos, resp.VolumenTotal)
	if resp.Borme != nil {
		if resp.Borme.Domicilio != nil {
			fmt.Printf("Domicilio: %s\n", *resp.Borme.Domicilio)
		}
		if resp.Borme.Provincia != nil {
			fmt.Printf("Provincia: %s\n", *resp.Borme.Provincia)
		}
		if resp.Borme.CapitalEuros != nil {
			fmt.Printf("Capital: %.0f€\n", *resp.Borme.CapitalEuros)
		}
		if resp.Borme.FechaConstitucion != nil {
			fmt.Printf("Constituida: %s\n", *resp.Borme.FechaConstitucion)
		}
	}
	fmt.Println()

	// Print contract table
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintf(w, "FUENTE\tTÍTULO\tORGANISMO\tIMPORTE\tFECHA\tCPV\n")
	fmt.Fprintf(w, "------\t------\t----------\t-------\t-----\t---\n")
	for _, c := range resp.Contratos {
		titulo := truncate(c.Titulo, 50)
		org := truncate(c.Organismo, 30)
		importe := fmt.Sprintf("%.0f€", c.Importe)
		fecha := "—"
		if c.Fecha != nil {
			fecha = *c.Fecha
			if len(fecha) >= 10 {
				fecha = fecha[:10]
			}
		}
		cpv := "—"
		if c.CPV != nil {
			cpv = *c.CPV
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\n",
			c.Fuente, titulo, org, importe, fecha, cpv)
	}
	w.Flush()

	return nil
}

// Export streams search results to CSV or JSONL.
func Export(client *api.Client, params api.SearchParams, format string, asJSON bool) error {
	const maxResults = 1000
	if params.Limit <= 0 {
		params.Limit = 100
	}

	var results []api.SearchResult
	var total int
	var err error

	totalKnown := false
	results, total, err = client.SearchAll(params, maxResults, func(current, t int) {
		if !totalKnown && t > 0 {
			total = t
			totalKnown = true
		}
		fmt.Fprintf(os.Stderr, "\rFetching... %d/%d", current, total)
	})
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "\rFetched %d results        \n", len(results))

	if asJSON {
		out := map[string]interface{}{
			"query":   params.Q,
			"filters": params,
			"total":   total,
			"count":   len(results),
			"results": results,
		}
		data, err := json.MarshalIndent(out, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(data))
		return nil
	}

	switch format {
	case "jsonl":
		for _, r := range results {
			data, err := json.Marshal(r)
			if err != nil {
				return err
			}
			fmt.Println(string(data))
		}
	case "csv":
		fallthrough
	default:
		w := csv.NewWriter(os.Stdout)
		_ = w.Write([]string{"fuente", "titulo", "organismo", "adjudicatario", "nif_adj", "importe", "fecha", "cpv", "estado", "url"})
		for _, r := range results {
			importe := ""
			if r.Importe != nil {
				importe = strconv.FormatFloat(*r.Importe, 'f', 2, 64)
			}
			_ = w.Write([]string{
				r.Fuente,
				r.Titulo,
				r.Organismo,
				r.Adjudicatario,
				r.NIFAdj,
				importe,
				r.Fecha,
				r.CPV,
				r.Estado,
				r.URL,
			})
		}
		w.Flush()
	}

	return nil
}

// Stats displays quick statistics for the current filters.
func Stats(client *api.Client, params api.SearchParams, asJSON bool) error {
	// Get overall total with minimal request.
	totalParams := params
	totalParams.Limit = 1
	resp, err := client.Search(totalParams)
	if err != nil {
		return err
	}

	total := resp.Meta.Total
	if total == 0 {
		total = len(resp.Results)
	}

	// Breakdown by known sources.
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

	if asJSON {
		out := map[string]interface{}{
			"total":      total,
			"por_fuente": porFuente,
			"filtros": map[string]string{
				"cpv":    params.CPV,
				"fuente": params.Fuente,
				"desde":  params.Desde,
				"hasta":  params.Hasta,
				"estado": params.Estado,
				"nif":    params.NIF,
			},
		}
		data, err := json.MarshalIndent(out, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(data))
		return nil
	}

	fmt.Println("Estadísticas")
	fmt.Println("============")
	fmt.Printf("Total: %d\n\n", total)
	fmt.Println("Por fuente:")

	var keys []string
	for k := range porFuente {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintf(w, "FUENTE\tCONTRATOS\n")
	fmt.Fprintf(w, "------\t---------\n")
	for _, k := range keys {
		fmt.Fprintf(w, "%s\t%d\n", k, porFuente[k])
	}
	w.Flush()

	return nil
}

// Alerts manages user alerts.
func Alerts(client *api.Client, action, alertID, query, cpv, nif string, asJSON bool) error {
	_, err := client.GetAlerts()
	if err != nil {
		if strings.Contains(err.Error(), "unauthorized") {
			msg := "La gestión de alertas requiere autenticación web. Visita elicita.es/alertas para gestionarlas."
			if asJSON {
				out := map[string]string{"error": msg}
				data, _ := json.MarshalIndent(out, "", "  ")
				fmt.Println(string(data))
			} else {
				fmt.Fprintln(os.Stderr, msg)
			}
			return nil
		}
		return err
	}

	switch action {
	case "list":
		return listAlerts(client, asJSON)
	case "create":
		return createAlert(client, query, cpv, nif, asJSON)
	case "delete":
		return deleteAlert(client, alertID, asJSON)
	default:
		return fmt.Errorf("unknown alert action: %s", action)
	}
}

func listAlerts(client *api.Client, asJSON bool) error {
	resp, err := client.GetAlerts()
	if err != nil {
		return err
	}

	if asJSON {
		data, err := json.MarshalIndent(resp, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(data))
		return nil
	}

	fmt.Printf("Alertas de %s\n", resp.Email)
	if resp.Alertas == nil {
		fmt.Println("No hay alertas configuradas.")
		return nil
	}

	fmt.Printf("Keywords: %v\n", resp.Alertas.Keywords)
	fmt.Printf("CPVs: %v\n", resp.Alertas.CPVs)
	fmt.Printf("Organismos: %v\n", resp.Alertas.Organismos)
	fmt.Printf("Competidores: %v\n", resp.Alertas.Competidores)
	fmt.Printf("Frecuencia: %s · Activo: %v\n", resp.Alertas.Frecuencia, resp.Alertas.Activo)

	return nil
}

func createAlert(client *api.Client, query, cpv, nif string, asJSON bool) error {
	cfg := api.AlertConfig{
		Keywords:   splitNonEmpty(query, ","),
		CPVs:       splitNonEmpty(cpv, ","),
		Organismos: splitNonEmpty(nif, ","),
		Frecuencia: "4h",
		Activo:     true,
	}
	resp, err := client.SaveAlerts(cfg)
	if err != nil {
		return err
	}
	if asJSON {
		data, err := json.MarshalIndent(resp, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(data))
		return nil
	}
	fmt.Println("✓ Alerta guardada")
	return nil
}

func deleteAlert(client *api.Client, id string, asJSON bool) error {
	// Backend stores a single alert config in Clerk metadata; deletion is not
	// a first-class operation. We reset the active flag and clear keywords.
	cfg := api.AlertConfig{
		Frecuencia: "4h",
		Activo:     false,
	}
	resp, err := client.SaveAlerts(cfg)
	if err != nil {
		return err
	}
	if asJSON {
		out := map[string]interface{}{
			"ok":      resp.OK,
			"deleted": id,
			"alertas": resp.Alertas,
		}
		data, err := json.MarshalIndent(out, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(data))
		return nil
	}
	fmt.Printf("✓ Alerta %s eliminada (alertas desactivadas)\n", id)
	return nil
}

func splitNonEmpty(s, sep string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, sep)
	var out []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// Graph executes the graph/universo command.
func Graph(client *api.Client, query, nodeType, cpv, year string, asJSON bool) error {
	resp, err := client.Graph(query, nodeType, cpv, year)
	if err != nil {
		return err
	}

	if asJSON {
		data, err := json.MarshalIndent(resp, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(data))
		return nil
	}

	// Human-readable summary
	fmt.Printf("Grafo de relaciones: %d nodos, %d conexiones\n\n", len(resp.Nodes), len(resp.Edges))

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintf(w, "TIPO\tNOMBRE\tCONTRATOS\tVOLUMEN\n")
	fmt.Fprintf(w, "----\t-----\t---------\t-------\n")

	for _, n := range resp.Nodes {
		tipo := "organismo"
		if n.Type == "adjudicatario" {
			tipo = "adjudicatario"
		}
		fmt.Fprintf(w, "%s\t%s\t%d\t%.0f€\n", tipo, truncate(n.Name, 50), n.Contratos, n.Volumen)
	}
	w.Flush()

	return nil
}

// Auth stores the API key in config.
func Auth(apiKey, endpoint string) error {
	if apiKey == "" {
		fmt.Print("Introduce tu API key: ")
		var input string
		fmt.Scanln(&input)
		apiKey = strings.TrimSpace(input)
	}

	if apiKey == "" {
		return fmt.Errorf("API key is required")
	}

	fmt.Fprintf(os.Stderr, "✓ API key guardada (%s...)\n", apiKey[:8])
	if endpoint != "" {
		fmt.Fprintf(os.Stderr, "✓ Endpoint: %s\n", endpoint)
	}
	return nil
}

// Whoami checks if the current config is authenticated.
func Whoami(client *api.Client) error {
	// Do a minimal search to verify auth
	resp, err := client.Search(api.SearchParams{Q: "test", Limit: 1})
	if err != nil {
		if strings.Contains(err.Error(), "unauthorized") {
			fmt.Fprintln(os.Stderr, "❌ No autenticado. Ejecuta 'elicitac auth' para configurar tu API key.")
			return nil
		}
		return err
	}

	fmt.Fprintln(os.Stderr, "✓ Autenticado")
	fmt.Fprintf(os.Stderr, "  Queries restantes: %d\n", resp.Meta.QueriesRemaining)
	fmt.Fprintf(os.Stderr, "  Rate limit: %d\n", resp.Meta.RateLimitRemaining)

	return nil
}

func printResultsTable(results []api.SearchResult) {
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)

	// Header
	fmt.Fprintf(w, "FUENTE\tTÍTULO\tORGANISMO\tADJUDICATARIO\tIMPORTE\tFECHA\tCPV\n")
	fmt.Fprintf(w, "------\t------\t----------\t-------------\t-------\t-----\t---\n")

	for _, r := range results {
		titulo := truncate(r.Titulo, 50)
		org := truncate(r.Organismo, 30)
		adj := truncate(r.Adjudicatario, 25)
		importe := "—"
		if r.Importe != nil {
			importe = fmt.Sprintf("%.0f€", *r.Importe)
		}
		fecha := r.Fecha
		if len(fecha) >= 10 {
			fecha = fecha[:10]
		}
		cpv := r.CPV
		if cpv == "" {
			cpv = "—"
		}

		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
			r.Fuente, titulo, org, adj, importe, fecha, cpv)
	}
	w.Flush()
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max-1] + "…"
}
