#!/usr/bin/env bash
set -euo pipefail

# deploy.sh — Automated deploy workflow for PM2-served projects
# Usage: ./deploy.sh "type(scope): description"
# Requires: deploy.config.json in the same directory

CONFIG="deploy.config.json"
ESTADO="ESTADO.md"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }
info() { echo -e "${YELLOW}→${NC} $1"; }

# --- Pre-flight checks ---
[ -f "$CONFIG" ] || fail "deploy.config.json not found"
[ -d .git ] || fail "Not a git repository"

BRANCH=$(git branch --show-current)
[ "$BRANCH" != "main" ] || fail "Cannot deploy from main. Create a feat/ or fix/ branch first."

# Parse config
PM2_PROCESS=$(jq -r '.pm2_process' "$CONFIG")
BUILD_COMMAND=$(jq -r '.build_command' "$CONFIG")
BUILD_DIR=$(jq -r '.build_dir // "."' "$CONFIG")
MAIN_BRANCH=$(jq -r '.main_branch // "main"' "$CONFIG")
REMOTE=$(jq -r '.remote // "origin"' "$CONFIG")
ESTADO_FILE=$(jq -r '.estado_file // "ESTADO.md"' "$CONFIG")

[ -n "$PM2_PROCESS" ] || fail "pm2_process not set in config"
[ -n "$BUILD_COMMAND" ] || fail "build_command not set in config"

COMMIT_MSG="${1:-}"
[ -n "$COMMIT_MSG" ] || fail "Usage: ./deploy.sh \"type(scope): description\""

# Validate conventional commit format
if ! echo "$COMMIT_MSG" | grep -qE '^(feat|fix|refactor|docs|style|chore|perf|test|revert)\([a-z0-9-]+\): .+'; then
  if ! echo "$COMMIT_MSG" | grep -qE '^(feat|fix|refactor|docs|style|chore|perf|test|revert): .+'; then
    fail "Commit message must follow conventional commits: 'type(scope): description'"
  fi
fi

info "Deploy workflow starting..."
info "Branch: $BRANCH | PM2: $PM2_PROCESS | Build: $BUILD_COMMAND"

# --- Step 0: Regeneración de rankings (fail-open — tarea 52) ---
# Los 4 JSON de rankings (adjudicatarios + organismos, importe y volumen) se
# regeneran contra la BD viva ANTES del commit: entran en el `git add -A` del
# Step 1 del propio deploy — el mismo flujo por el que entra ESTADO.md — y en
# el build del mismo deploy, sin dejar el árbol sucio entre deploys.
# FAIL-OPEN deliberado: si un generador falla (BD ausente, banda de cordura
# fuera de rango, …) se registra WARNING y el deploy continúa con los JSON
# versionados — un deploy NUNCA se rompe por un ranking; la banda fallida
# conserva el snapshot anterior. Los sitemaps NO van aquí: corren dentro del
# build vía web/post-build.mjs con sus propias guardas y contabilidad exacta.
info "Regenerating rankings from live DB (fail-open)..."
regenera_ranking() {
  local nombre="$1" script="$2" out
  if out=$( cd "$BUILD_DIR" && node "scripts/$script" 2>&1 ); then
    echo "$out" | grep -E '\[rankings\] (top1|filas)' | while IFS= read -r line; do ok "$line"; done || true
    ok "Rankings de $nombre regenerados"
  else
    echo "$out" | tail -n 3 >&2
    echo -e "${YELLOW}⚠ WARNING: generador de rankings de $nombre falló — se continúa con los JSON versionados${NC}"
  fi
}
regenera_ranking "adjudicatarios" "generar-rankings-adjudicatarios.mjs"
regenera_ranking "organismos" "generar-rankings-organismos.mjs"

# --- Step 1: Commit ---
info "Committing changes..."
git add -A
git commit -m "$COMMIT_MSG" || info "Nothing to commit (clean working tree)"
COMMIT_HASH=$(git rev-parse --short HEAD)
ok "Committed: $COMMIT_HASH — $COMMIT_MSG"

# --- Step 2: Push ---
info "Pushing to $REMOTE/$BRANCH..."
git push "$REMOTE" "$BRANCH"
ok "Pushed to $REMOTE/$BRANCH"

# --- Step 3: Build ---
info "Building in $BUILD_DIR/..."
( cd "$BUILD_DIR" && eval "$BUILD_COMMAND" ) || fail "Build failed"
ok "Build successful"

# --- Step 3.5: Promote staging build to production (decouple build from serving) ---
info "Promoting dist-staging -> dist (release + rollback symlink)..."
TS=$(date -u +%Y%m%d%H%M%S)
RELEASE_ROOT="/var/data/elicita-releases"
RELEASE_DIR="$RELEASE_ROOT/$TS"
mkdir -p "$RELEASE_DIR"
rsync -a --delete "$BUILD_DIR/dist-staging/" "$BUILD_DIR/dist/"
cp -r "$BUILD_DIR/dist/." "$RELEASE_DIR/"
# F1.2/node-api: el entry de la release resuelve imports externos (duckdb, etc.)
# subiendo por directorios — sin node_modules la release no arranca (13-10:
# ERR_MODULE_NOT_FOUND al consolidar PM2 → current). Embed REAL con hardlinks
# (cp -al; /srv y /var/data verificados en el MISMO filesystem ext4 raíz):
# la release deja de depender del árbol de build — cierra la clase P0
# «producción sirve del árbol» (incidentes 29-09 y 13-10). npm ci reescribe
# los ficheros con inodos nuevos → las releases conservan el inode viejo
# (estabilidad gratuita: 5 releases comparten inodos ≈ coste de un node_modules).
if ! cp -al "$BUILD_DIR/node_modules" "$RELEASE_DIR/node_modules" 2>/dev/null; then
  # Fallback cross-filesystem: copia completa (más disco, misma independencia).
  rm -rf "$RELEASE_DIR/node_modules"
  rsync -a "$BUILD_DIR/node_modules/" "$RELEASE_DIR/node_modules/"
fi
ln -sfn "$RELEASE_DIR" "$RELEASE_ROOT/current"
ls -1t "$RELEASE_ROOT" | grep -v '^current$' | tail -n +6 | while read -r old; do rm -rf "$RELEASE_ROOT/$old"; done
ok "Promoted to production (release $TS, last 5 kept)"

# --- Step 4: Restart PM2 ---
info "Restarting PM2 process: $PM2_PROCESS..."
pm2 restart "$PM2_PROCESS" || fail "PM2 restart failed"
ok "PM2 restarted: $PM2_PROCESS"

# --- Step 5: Smoke test ---
# Verify the deployed origin through Nginx, bypassing Cloudflare's bot challenge.
# Public browser verification follows separately; a WAF 403 from curl is not a release failure.
info "Running origin smoke tests (Nginx, Cloudflare bypassed)..."
SMOKE_URLS=$(jq -r '.smoke_urls[]' "$CONFIG")
SMOKE_HOST=$(printf '%s\n' "$SMOKE_URLS" | head -n1 | sed -E 's#https?://([^/]+).*#\1#')
ALL_OK=true
SMOKE_RESULTS=""
for url in $SMOKE_URLS; do
  # PM2 may need a few seconds to bind after restart; retry transient origin errors.
  HTTP_CODE="000"
  for attempt in 1 2 3 4 5 6; do
    HTTP_CODE=$(curl -ksS -o /dev/null -w "%{http_code}" --max-time 10 --resolve "${SMOKE_HOST}:443:127.0.0.1" "$url" 2>/dev/null || echo "000")
    case "$HTTP_CODE" in 200|301|302) break ;; esac
    [ "$attempt" = 6 ] || sleep 1
  done
  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "301" ] || [ "$HTTP_CODE" = "302" ]; then
    ok "$url → $HTTP_CODE (origin)"
    SMOKE_RESULTS+="| $url | ✅ $HTTP_CODE (origin) |"$'\n'
  else
    echo -e "${RED}✗${NC} $url → $HTTP_CODE (origin)"
    SMOKE_RESULTS+="| $url | ❌ $HTTP_CODE (origin) |"$'\n'
    ALL_OK=false
  fi
done

if [ "$ALL_OK" = false ]; then
  echo ""
  fail "Origin smoke test failed! Rollback procedure:
  1. git revert HEAD --no-edit
  2. ./deploy.sh \"fix: rollback — smoke test failure\"
  3. If build broken: pm2 restart $PM2_PROCESS (restarts from last good state)"
fi

ok "All origin smoke tests passed"


# --- Step 6: Update ESTADO.md ---
info "Updating $ESTADO_FILE..."
TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M UTC")
PROJECT_NAME=$(basename $(git rev-parse --show-toplevel))

# Get PM2 status
PM2_STATUS=$(pm2 jlist 2>/dev/null | jq -r ".[] | select(.name == \"$PM2_PROCESS\") | .pm2_env.status" 2>/dev/null || echo "unknown")

# Read existing history (last 9 entries)
HISTORY=""
if [ -f "$ESTADO_FILE" ]; then
  HISTORY=$(grep -A 100 '## Historial reciente' "$ESTADO_FILE" 2>/dev/null | tail -n +3 | head -10)
fi

cat > "$ESTADO_FILE" << EOF
# ESTADO.md — $PROJECT_NAME

**Último deploy:** $TIMESTAMP
**Commit:** $COMMIT_HASH — $COMMIT_MSG
**Rama deployada:** $BRANCH
**Servicio:** $PM2_PROCESS (PM2) — ✅ ${PM2_STATUS:-online}

## Smoke test
| URL | Status |
|---|---|
$(echo "$SMOKE_RESULTS" | sed '/^$/d')

## Historial reciente
| Fecha | Commit | Cambio |
|---|---|---|
| $TIMESTAMP | $COMMIT_HASH | $COMMIT_MSG |
$(echo "$HISTORY" | head -9)
EOF

ok "$ESTADO_FILE updated"

# --- Done ---
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✅ DEPLOY COMPLETADO${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "  Branch:  $BRANCH"
echo "  Commit:  $COMMIT_HASH"
echo "  PM2:     $PM2_PROCESS"
echo "  ESTADO:  $ESTADO_FILE"
echo ""
echo "  Next: merge to $MAIN_BRANCH and push"
echo "    git checkout $MAIN_BRANCH && git merge $BRANCH && git push $REMOTE $MAIN_BRANCH"
echo "    git branch -d $BRANCH"