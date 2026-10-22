package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/elCanosail/elicita-cli/internal/api"
)

// PredictResult is a single renewal prediction for an organism/CPV group.
type PredictResult struct {
	Organismo              string  `json:"organismo"`
	CPV                    string  `json:"cpv"`
	TotalContratos         int     `json:"total_contratos"`
	UltimoContrato         string  `json:"ultimo_contrato"`
	IntervaloPromedioMeses float64 `json:"intervalo_promedio_meses"`
	ProximaEstimada        string  `json:"proxima_estimada"`
	ValorEstimado          float64 `json:"valor_estimado"`
	Confianza              string  `json:"confianza"`
}

// PredictOutput is the complete JSON output for the predict command.
type PredictOutput struct {
	NIF          string          `json:"nif"`
	Nombre       string          `json:"nombre"`
	Predicciones []PredictResult `json:"predicciones"`
	Meta         struct {
		TotalGrupos   int `json:"total_grupos"`
		DentroDeMeses int `json:"dentro_de_meses"`
	} `json:"meta"`
}

// Predict estimates upcoming contract renewals for an adjudicatario NIF.
func Predict(client *api.Client, nif string, months int, asJSON bool) error {
	nif = normalizeNIF(nif)
	if nif == "" {
		return fmt.Errorf("NIF requerido")
	}

	resp, err := client.GetOrg(nif)
	if err != nil {
		return err
	}

	if !resp.OK || len(resp.Contratos) == 0 {
		fmt.Fprintf(os.Stderr, "No se encontraron contratos para el NIF %s\n", nif)
		return nil
	}

	predictions := calculatePredictions(resp.Contratos, months)
	if len(predictions) == 0 {
		fmt.Fprintln(os.Stderr, "Datos insuficientes para predicción. Se necesitan al menos 2 contratos del mismo organismo.")
		return nil
	}

	if asJSON {
		out := PredictOutput{
			NIF:          resp.NIF,
			Nombre:       resp.Nombre,
			Predicciones: predictions,
		}
		out.Meta.TotalGrupos = len(predictions)
		out.Meta.DentroDeMeses = months
		data, err := json.MarshalIndent(out, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(data))
		return nil
	}

	printPredictionsTable(nif, resp.Nombre, predictions)
	return nil
}

func calculatePredictions(contratos []api.OrgContrato, months int) []PredictResult {
	now := time.Now()
	// Date-only comparison to avoid excluding predictions that fall on today's date.
	nowDate := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	cutoff := nowDate.AddDate(0, months, 0)

	// Group by organism (fallback to CPV).
	groups := make(map[string]*predictionGroup)
	for _, c := range contratos {
		if c.Importe <= 0 || c.Fecha == nil || *c.Fecha == "" {
			continue
		}
		key := c.Organismo
		if key == "" {
			cpv := ""
			if c.CPV != nil {
				cpv = *c.CPV
			}
			key = "CPV " + cpv
		}
		g, ok := groups[key]
		if !ok {
			g = &predictionGroup{
				organismo: c.Organismo,
				cpv:       "",
			}
			if c.CPV != nil {
				g.cpv = *c.CPV
			}
			groups[key] = g
		}
		g.contratos = append(g.contratos, c)
	}

	var results []PredictResult
	for _, g := range groups {
		if len(g.contratos) < 2 {
			continue
		}

		// Sort contracts by date ascending.
		sort.Slice(g.contratos, func(i, j int) bool {
			return parseDate(g.contratos[i].Fecha).Before(parseDate(g.contratos[j].Fecha))
		})

		var intervals []float64
		var totalValue float64
		for i, c := range g.contratos {
			if i > 0 {
				prev := g.contratos[i-1]
				d := monthsBetween(parseDate(prev.Fecha), parseDate(c.Fecha))
				if d > 0 {
					intervals = append(intervals, d)
				}
			}
			totalValue += c.Importe
		}

		if len(intervals) == 0 {
			continue
		}

		avgInterval := avg(intervals)
		last := g.contratos[len(g.contratos)-1]
		lastDate := parseDate(last.Fecha)
		nextDate := lastDate.AddDate(0, 0, int(avgInterval*30.4375+0.5))

		if nextDate.After(cutoff) || !nextDate.After(nowDate) {
			continue
		}

		results = append(results, PredictResult{
			Organismo:              g.organismo,
			CPV:                    g.cpv,
			TotalContratos:         len(g.contratos),
			UltimoContrato:         formatDate(lastDate),
			IntervaloPromedioMeses: round1(avgInterval),
			ProximaEstimada:        formatDate(nextDate),
			ValorEstimado:          round2(totalValue / float64(len(g.contratos))),
			Confianza:              confidenceLabel(len(g.contratos)),
		})
	}

	// Sort by predicted date ascending.
	sort.Slice(results, func(i, j int) bool {
		return results[i].ProximaEstimada < results[j].ProximaEstimada
	})

	return results
}

type predictionGroup struct {
	organismo string
	cpv       string
	contratos []api.OrgContrato
}

func confidenceLabel(n int) string {
	switch {
	case n >= 6:
		return "alta"
	case n >= 3:
		return "media"
	default:
		return "baja"
	}
}

func avg(values []float64) float64 {
	var sum float64
	for _, v := range values {
		sum += v
	}
	return sum / float64(len(values))
}

func monthsBetween(a, b time.Time) float64 {
	return b.Sub(a).Hours() / 24 / 30.4375
}

func parseDate(s *string) time.Time {
	if s == nil || *s == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02", "2006-01-02T15:04:05", "2006/01/02"} {
		if t, err := time.Parse(layout, *s); err == nil {
			return t
		}
	}
	return time.Time{}
}

func formatDate(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format("2006-01-02")
}

func round1(f float64) float64 {
	return float64(int(f*10+0.5)) / 10
}

func round2(f float64) float64 {
	return float64(int(f*100+0.5)) / 100
}

func normalizeNIF(s string) string {
	s = strings.TrimSpace(s)
	return strings.ToUpper(s)
}

func printPredictionsTable(nif, nombre string, preds []PredictResult) {
	fmt.Printf("Predicciones de renovación para %s (%s)\n\n", nombre, nif)

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintf(w, "ORGANISMO\tÚLTIMO CONTRATO\tINTERVALO\tPRÓXIMA EST.\tVALOR EST.\tCONFIANZA\n")
	fmt.Fprintf(w, "---------\t---------------\t---------\t------------\t----------\t---------\n")
	for _, p := range preds {
		org := p.Organismo
		if org == "" {
			org = "CPV " + p.CPV
		}
		fmt.Fprintf(w, "%s\t%s\t%.0f meses\t%s\t%.0f€\t%s\n",
			truncate(org, 30),
			p.UltimoContrato,
			p.IntervaloPromedioMeses,
			p.ProximaEstimada,
			p.ValorEstimado,
			p.Confianza,
		)
	}
	w.Flush()
}
