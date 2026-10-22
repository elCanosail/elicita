#!/bin/bash
# Backfill Euskadi 2011-2023 — wrapper para exec preflight
cd /root/.openclaw/workspace/projects/elicita/ingesta
exec node --max-old-space-size=2048 connectors/euskadi_v2.js --backfill --from=2011 --to=2023
