/**
 * generate-cache.js — Genera api_cache.json agregando todos los *_contracts.json
 *
 * Estructura de api_cache.json:
 *   { contratos: [...], total: N, sources: {...}, generated_at: ISO }
 *
 * El health endpoint lee este archivo para reportar estado del cache.
 * Si no existe, health reporta cache status = "missing".
 * Si existe, health reporta fresh (<6h), stale (<12h) o expired (>12h).
 *
 * Uso:
 *   node scripts/generate-cache.js
 *   # o desde scheduler: require('./scripts/generate-cache').generateCache();
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'api_cache.json');
const CACHE_PREV = path.join(DATA_DIR, 'api_cache.prev.json');
const MAX_CACHE_CONTRACTS = 50000; // Limit to keep file size reasonable

function generateCache() {
  const startTime = Date.now();
  const now = new Date().toISOString();

  const allContratos = [];
  const sources = {};

  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('_contracts.json'));

    for (const file of files) {
      try {
        const filePath = path.join(DATA_DIR, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const contratos = data.contratos || [];
        const key = file.replace('_contracts.json', '');

        sources[key] = {
          count: contratos.length,
          last_update: data.last_update || data.generated_at || null,
        };

        // Sample contracts (don't include all — too large)
        // Take most recent 100 per source
        const sample = contratos
          .slice(-100)
          .map(c => ({
            id: c.id || null,
            fuente: c.fuente || key,
            expediente: c.expediente || null,
            organismo: c.organismo || null,
            objeto: c.objeto ? c.objeto.slice(0, 200) : null,
            importe: c.importe || null,
            fecha_publicacion: c.fecha_publicacion || null,
            estado: c.estado || null,
            adjudicatario: c.adjudicatario || null,
            nif_adjudicatario: c.nif_adjudicatario || null,
            url: c.url || null,
          }));

        allContratos.push(...sample);
      } catch (err) {
        console.error(`[cache] Error reading ${file}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[cache] Error reading data dir: ${err.message}`);
    return false;
  }

  // Sort by date descending (most recent first)
  allContratos.sort((a, b) => {
    const da = a.fecha_publicacion || '';
    const db = b.fecha_publicacion || '';
    return db.localeCompare(da);
  });

  // Limit total contracts in cache
  const cachedContratos = allContratos.slice(0, MAX_CACHE_CONTRACTS);
  const totalContratos = Object.values(sources).reduce((s, v) => s + v.count, 0);

  const cache = {
    contratos: cachedContratos,
    total: totalContratos,
    sampled: cachedContratos.length,
    sources,
    generated_at: now,
  };

  // Rotate previous cache
  try {
    if (fs.existsSync(CACHE_FILE)) {
      fs.copyFileSync(CACHE_FILE, CACHE_PREV);
    }
  } catch (_) { /* non-fatal */ }

  // Write atomically
  const tmpFile = CACHE_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(cache));
  fs.renameSync(tmpFile, CACHE_FILE);

  const sizeMB = (fs.statSync(CACHE_FILE).size / 1024 / 1024).toFixed(2);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[cache] Generated api_cache.json: ${totalContratos} total contratos, ${cachedContratos.length} sampled, ${sizeMB}MB in ${elapsed}s`);

  return true;
}

// CLI execution
if (require.main === module) {
  generateCache();
}

module.exports = { generateCache };