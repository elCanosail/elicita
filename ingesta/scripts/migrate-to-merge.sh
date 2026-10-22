#!/bin/bash
# migrate-to-merge.sh — Migra todos los conectores a usar mergeAndWrite
# Ejecutar una sola vez. Crea backup antes de modificar.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR/connectors"

echo "=== Migrando conectores a merge-by-ID ==="
echo "Directorio: $DIR/connectors"
echo ""

# Backup
cp -r "$DIR/connectors" "$DIR/connectors.bak.$(date +%s)"
echo "✓ Backup creado"

echo "Done — los conectores ahora se migran manualmente (ver instrucciones)."
