// elicitac — Elicita CLI
// Agent-friendly CLI for elicita.es API
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/elCanosail/elicita-cli/internal/api"
	"github.com/elCanosail/elicita-cli/internal/commands"
	"github.com/elCanosail/elicita-cli/internal/config"
)

const usage = `elicitac — Elicita CLI

Agent-friendly CLI for Spanish public procurement data.
66.4M+ records. Search, explore, and export from the terminal.

USAGE:
  elicitac <command> [flags]

COMMANDS:
  search <query>     Search across all procurement tables
  org <NIF>          Company/organism profile from adjudicatario NIF
  export <query>     Dump search results to CSV/JSONL
  stats              Quick statistics for filters
  alerts             Manage alerts (requires web auth)
  predict <NIF>      Predict upcoming contract renewals for an adjudicatario NIF
  auth               Set your API key
  whoami             Check authentication status
  version            Show version info

SEARCH FLAGS:
  --cpv <code>       Filter by CPV code (prefix match)
  --nif <nif>        Filter by adjudicatario NIF
  --estado <state>   Filter by status (Adjudicada, Publique, ...)
  --fuente <src>     Filter by source (PLACE, TED, Andalucía, ...)
  --desde <year>     From year (e.g. 2024)
  --hasta <year>     To year (e.g. 2026)
  --min <amount>     Minimum importe (euros)
  --max <amount>     Maximum importe (euros)
  --limit <n>        Max results (default 20, max 100)
  --offset <n>       Pagination offset
  --sort <col>       Sort column (titulo, organismo, importe, fecha, fuente)
  --dir <dir>        Sort direction (asc, desc)
  --json             Output as JSON (for agents/pipes)

EXPORT FLAGS:
  --csv              Output CSV (default)
  --jsonl            Output JSONL
  --limit <n>        Page size for pagination (default 100)
  (also accepts all search flags)

ORG FLAGS:
  --json             Output as JSON

STATS FLAGS:
  --cpv <code>       Filter by CPV
  --fuente <src>     Filter by source
  --year <YYYY>      Filter by year (sets desde/hasta)
  --json             Output as JSON

ALERTS FLAGS:
  --list             List alerts
  --create           Create alert
  --delete <id>      Delete alert
  --query <text>     Keywords/query for new alert
  --cpv <codes>      Comma-separated CPV codes
  --nif <nifs>       Comma-separated NIFs/organismos
  --json             Output as JSON

GRAPH FLAGS:
  --type <type>      Node type (organismo, adjudicatario)
  --cpv <code>       Filter by CPV
  --year <year>      Filter by year
  --json             Output as JSON

PREDICT FLAGS:
  --months <n>       Look-ahead window in months (default 12)
  --json             Output as JSON

AUTH FLAGS:
  --key <key>        API key (skip prompt)
  --endpoint <url>   Custom API endpoint (default: https://elicita.es)

EXAMPLES:
  elicitac search "mantenimiento HVAC" --json --limit 10
  elicitac search "Telefónica" --nif A78901234 --desde 2024 --json
  elicitac org B15044357 --json
  elicitac export "HVAC" --csv > hvac.csv
  elicitac export "software" --jsonl | jq '.titulo'
  elicitac stats --cpv 72 --fuente PLACE --json
  elicitac alerts --list
  elicitac alerts --create --query "mantenimiento HVAC" --cpv 72,48
  elicitac graph "Red.es" --type organismo --json
  elicitac predict B15044357 --months 18
  elicitac predict B15044357 --json --months 24
  elicitac auth --key elc_xxxxxxxx
  elicitac whoami
`

func main() {
	if len(os.Args) < 2 {
		fmt.Print(usage)
		os.Exit(1)
	}

	cmd := os.Args[1]
	args := os.Args[2:]

	switch cmd {
	case "search":
		cmdSearch(args)
	case "org":
		cmdOrg(args)
	case "export":
		cmdExport(args)
	case "stats":
		cmdStats(args)
	case "alerts":
		cmdAlerts(args)
	case "graph":
		cmdGraph(args)
	case "predict":
		cmdPredict(args)
	case "auth":
		cmdAuth(args)
	case "whoami":
		cmdWhoami(args)
	case "version", "--version", "-v":
		fmt.Println("elicitac v0.3.0")
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n\n", cmd)
		fmt.Print(usage)
		os.Exit(1)
	}
}

func parseSearchFlags(fs *flag.FlagSet) *api.SearchParams {
	p := &api.SearchParams{}
	fs.StringVar(&p.CPV, "cpv", "", "Filter by CPV code")
	fs.StringVar(&p.NIF, "nif", "", "Filter by NIF")
	fs.StringVar(&p.Estado, "estado", "", "Filter by status")
	fs.StringVar(&p.Fuente, "fuente", "", "Filter by source")
	fs.StringVar(&p.Desde, "desde", "", "From year")
	fs.StringVar(&p.Hasta, "hasta", "", "To year")
	fs.StringVar(&p.ImporteMin, "min", "", "Minimum importe")
	fs.StringVar(&p.ImporteMax, "max", "", "Maximum importe")
	fs.IntVar(&p.Limit, "limit", 20, "Max results")
	fs.IntVar(&p.Offset, "offset", 0, "Pagination offset")
	fs.StringVar(&p.Sort, "sort", "", "Sort column")
	fs.StringVar(&p.Dir, "dir", "desc", "Sort direction")
	return p
}

func cmdSearch(args []string) {
	fs := flag.NewFlagSet("search", flag.ExitOnError)
	p := parseSearchFlags(fs)
	asJSON := fs.Bool("json", false, "Output as JSON")
	fs.Parse(args)

	p.Q = strings.TrimSpace(fs.Arg(0))
	if p.Q == "" && p.CPV == "" && p.NIF == "" && p.Estado == "" && p.Fuente == "" {
		fmt.Fprintln(os.Stderr, "Error: provide a search term or at least one filter")
		os.Exit(1)
	}

	cfg := mustLoad()
	client := api.New(cfg.Endpoint, cfg.APIKey)

	if err := commands.Search(client, *p, *asJSON); err != nil {
		exitWithError(err)
	}
}

func cmdOrg(args []string) {
	fs := flag.NewFlagSet("org", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "Output as JSON")
	fs.Parse(args)

	nif := strings.TrimSpace(fs.Arg(0))
	if nif == "" {
		fmt.Fprintln(os.Stderr, "Error: provide a NIF")
		os.Exit(1)
	}

	cfg := mustLoad()
	client := api.New(cfg.Endpoint, cfg.APIKey)

	if err := commands.Org(client, nif, *asJSON); err != nil {
		exitWithError(err)
	}
}

func cmdExport(args []string) {
	fs := flag.NewFlagSet("export", flag.ExitOnError)
	p := parseSearchFlags(fs)
	asJSONL := fs.Bool("jsonl", false, "Output JSONL")
	asJSON := fs.Bool("json", false, "Output as JSON")
	fs.Parse(args)

	p.Q = strings.TrimSpace(fs.Arg(0))
	if p.Q == "" && p.CPV == "" && p.NIF == "" && p.Estado == "" && p.Fuente == "" {
		fmt.Fprintln(os.Stderr, "Error: provide a query or at least one filter")
		os.Exit(1)
	}

	format := "csv"
	if *asJSONL {
		format = "jsonl"
	}
	if *asJSON {
		format = "json"
	}

	cfg := mustLoad()
	client := api.New(cfg.Endpoint, cfg.APIKey)

	if err := commands.Export(client, *p, format, *asJSON); err != nil {
		exitWithError(err)
	}
}

func cmdStats(args []string) {
	fs := flag.NewFlagSet("stats", flag.ExitOnError)
	cpv := fs.String("cpv", "", "Filter by CPV")
	fuente := fs.String("fuente", "", "Filter by source")
	year := fs.String("year", "", "Filter by year")
	asJSON := fs.Bool("json", false, "Output as JSON")
	fs.Parse(args)

	p := api.SearchParams{
		CPV:    *cpv,
		Fuente: *fuente,
	}
	if *year != "" {
		p.Desde = *year
		p.Hasta = *year
	}

	cfg := mustLoad()
	client := api.New(cfg.Endpoint, cfg.APIKey)

	if err := commands.Stats(client, p, *asJSON); err != nil {
		exitWithError(err)
	}
}

func cmdAlerts(args []string) {
	fs := flag.NewFlagSet("alerts", flag.ExitOnError)
	list := fs.Bool("list", false, "List alerts")
	create := fs.Bool("create", false, "Create alert")
	deleteID := fs.String("delete", "", "Delete alert ID")
	query := fs.String("query", "", "Keywords/query")
	cpv := fs.String("cpv", "", "Comma-separated CPV codes")
	nif := fs.String("nif", "", "Comma-separated NIFs/organismos")
	asJSON := fs.Bool("json", false, "Output as JSON")
	fs.Parse(args)

	action := ""
	if *list {
		action = "list"
	} else if *create {
		action = "create"
	} else if *deleteID != "" {
		action = "delete"
	}

	if action == "" {
		fmt.Fprintln(os.Stderr, "Error: specify --list, --create, or --delete")
		os.Exit(1)
	}

	cfg := mustLoad()
	client := api.New(cfg.Endpoint, cfg.APIKey)

	if err := commands.Alerts(client, action, *deleteID, *query, *cpv, *nif, *asJSON); err != nil {
		exitWithError(err)
	}
}

func cmdGraph(args []string) {
	fs := flag.NewFlagSet("graph", flag.ExitOnError)
	nodeType := fs.String("type", "", "Node type (organismo, adjudicatario)")
	cpv := fs.String("cpv", "", "Filter by CPV")
	year := fs.String("year", "", "Filter by year")
	asJSON := fs.Bool("json", false, "Output as JSON")
	fs.Parse(args)

	query := strings.TrimSpace(fs.Arg(0))
	if query == "" {
		fmt.Fprintln(os.Stderr, "Error: provide an entity name")
		os.Exit(1)
	}

	cfg := mustLoad()
	client := api.New(cfg.Endpoint, cfg.APIKey)

	if err := commands.Graph(client, query, *nodeType, *cpv, *year, *asJSON); err != nil {
		exitWithError(err)
	}
}

func cmdPredict(args []string) {
	fs := flag.NewFlagSet("predict", flag.ExitOnError)
	months := fs.Int("months", 12, "Look-ahead window in months")
	asJSON := fs.Bool("json", false, "Output as JSON")
	fs.Parse(args)

	nif := strings.TrimSpace(fs.Arg(0))
	if nif == "" {
		fmt.Fprintln(os.Stderr, "Error: provide a NIF")
		os.Exit(1)
	}

	cfg := mustLoad()
	client := api.New(cfg.Endpoint, cfg.APIKey)

	if err := commands.Predict(client, nif, *months, *asJSON); err != nil {
		exitWithError(err)
	}
}

func cmdAuth(args []string) {
	fs := flag.NewFlagSet("auth", flag.ExitOnError)
	key := fs.String("key", "", "API key")
	endpoint := fs.String("endpoint", "", "Custom API endpoint")
	fs.Parse(args)

	if err := commands.Auth(*key, *endpoint); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	// Save config
	cfg := config.Default()
	if *key != "" {
		cfg.APIKey = *key
	}
	if *endpoint != "" {
		cfg.Endpoint = *endpoint
	}
	if err := config.Save(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not save config: %v\n", err)
	}
}

func cmdWhoami(args []string) {
	cfg := mustLoad()
	client := api.New(cfg.Endpoint, cfg.APIKey)
	if err := commands.Whoami(client); err != nil {
		exitWithError(err)
	}
}

func mustLoad() *config.Config {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Config error: %v\n", err)
		os.Exit(1)
	}
	return cfg
}

func exitWithError(err error) {
	fmt.Fprintf(os.Stderr, "Error: %v\n", err)
	msg := err.Error()
	if strings.Contains(msg, "unauthorized") {
		os.Exit(2)
	}
	if strings.Contains(msg, "rate limit") {
		os.Exit(3)
	}
	os.Exit(1)
}
