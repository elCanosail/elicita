# Market Intelligence Open Data v1 — P0

This is a **candidate-only** generator for the `technology` dataset. It never writes to `web/public`; publication needs the roadmap's editorial gate.

## Versioned inputs

A fixture must contain:

- `rows`: the canonical contract projection;
- `taxonomy`: `elicita.cpv-taxonomy/v1` with `include`, `exclude`, or `review` CPV rules;
- `identityRegistry`: `elicita.identity-registry/v1` with reviewed companies, evidence-backed groups, UTE records, and buyers.

`test/fixtures/technology-open-data-v1.json` is deliberately synthetic. Its empty group and UTE registers are meaningful: unknown ownership/repartition is not inferred.

## Local candidate

From `mcp-server`, after committing the pipeline so the tree is clean:

```sh
npm run generate:open-data -- \
  --fixture test/fixtures/technology-open-data-v1.json \
  --output /tmp/elicita-market-intelligence/technology-20260914-220000Z \
  --snapshot-id technology-20260914-220000Z \
  --generated-at 2026-09-14T22:00:00Z
```

The generator emits the complete v1 contract: snapshot, all seven CSVs, methodology, generation receipt, and checksums. It stages to a sibling temporary directory, validates every artifact, then renames it to the requested candidate location.

For a coherent copy of the live DuckDB, replace `--fixture` with `--duckdb /path/to/coherent-copy.duckdb`. The fixed projection in `TECHNOLOGY_DUCKDB_PROJECTION` runs with `duckdb -readonly -json` and maps the current `contratos_vivos` columns. Never point it at a locked or mutable live database: obtain a coherent read-only snapshot first.

## Promotion

`promoteCandidateAtomically` is intentionally not exposed through this CLI. A separate reviewed integration must validate the candidate, move it under `snapshots/{snapshot_id}`, and atomically replace the `latest` symlink. No generated candidate in this P0 is public data.
