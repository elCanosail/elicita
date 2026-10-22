#!/usr/bin/env node
/**
 * e2e-caminos.mjs — E2E de 3 caminos críticos públicos de elicita (propuesta A, run 09-10 14:00).
 *
 * Caminos:
 *   1. Buscar   — interacción REAL (input + click) sobre /buscar; espera tabla de resultados
 *                 con importes renderizados y contador "N resultados" (N ≥ 1).
 *   2. Perfil   — /perfil/B95241154 (CONSTRUCCIONES URDINBERRI, caso issue #22): agregados
 *                 con "importe corregido" y publicado visible.
 *   3. Ficha FARO — /mercado/tecnologia: kicker FARO, sección Concentración (HHI) y tabla de datos.
 *
 * Sin dependencias nuevas: driver CDP mínimo sobre WebSocket global de Node 26 y
 * chromium del sistema (CHROME_BIN, por defecto /usr/bin/chromium-browser).
 * Los checks son de CONTENIDO servido, no de latencia.
 *
 * Uso:
 *   node scripts/e2e-caminos.mjs [BASE]          # default http://127.0.0.1:4391
 *
 * Nota producción (BASE=https://elicita.es): el camino 1 ejecuta una búsqueda anónima real
 * que consume 1 de las 3 búsquedas diarias de la IP de origen (token bucket de
 * /api/public/search). Ejecutar de forma puntual, no programada en cron, o ajustar
 * SEARCH_QUERY abajo a algo igual de barato.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = (process.argv[2] || 'http://127.0.0.1:4391').replace(/\/+$/, '');
const SEARCH_QUERY = process.env.E2E_SEARCH_QUERY || 'consultoría';
const NAV_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 400;

/** Candidatos de binario chromium: env override → playwright cache (más nuevo) → sistema.
 *  El snap de /usr/bin/chromium-browser no puede escribir user-data-dir en /tmp —
 *  por eso los builds de playwright van primero. */
function chromeCandidates() {
  const candidates = [];
  if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);
  try {
    const pwRoot = join(process.env.HOME || '/root', '.cache/ms-playwright');
    for (const d of readdirSync(pwRoot).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const p = join(pwRoot, d, sub);
        if (existsSync(p)) candidates.push(p);
      }
    }
  } catch {}
  candidates.push('/usr/bin/chromium-browser', '/usr/bin/google-chrome');
  return [...new Set(candidates)];
}

const failures = [];
const notes = [];

function check(camino, name, ok, detail) {
  const line = `[${camino}] ${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`;
  console.log(line);
  if (!ok) failures.push(line);
  return ok;
}

/* ── Driver CDP mínimo ─────────────────────────────────────────────── */

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'e2e-caminos-'));
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--window-size=1440,1000',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    'about:blank',
  ];

  const devtoolsFile = join(profile, 'DevToolsActivePort');
  const launchDeadline = Date.now() + 20_000;
  let lastErr = 'sin candidatos';
  for (const bin of chromeCandidates()) {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    while (Date.now() < launchDeadline) {
      if (existsSync(devtoolsFile)) {
        const [port, path] = readFileSync(devtoolsFile, 'utf8').split('\n').map((s) => s.trim());
        if (port && path) return { child, profile, wsUrl: `ws://127.0.0.1:${port}${path}`, bin };
      }
      if (child.exitCode !== null) break;
      await sleep(200);
    }
    lastErr = `${bin} (exit ${child.exitCode})`;
    try { child.kill('SIGKILL'); } catch {}
  }
  rmSync(profile, { recursive: true, force: true });
  throw new Error(`ningún chromium escribió DevToolsActivePort en 20s — último: ${lastErr}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${msg.error.message}`));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (this.sessionId) payload.sessionId = this.sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }

  async openSession() {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessionId = sessionId;
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    return targetId;
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    const deadline = Date.now() + NAV_TIMEOUT_MS;
    for (;;) {
      const { result } = await this.send('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      });
      if (result?.value === 'complete') return;
      if (Date.now() > deadline) throw new Error(`navegación no completó en ${NAV_TIMEOUT_MS}ms: ${url}`);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  async eval(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      const d = exceptionDetails;
      throw new Error(`JS error: ${d.exception?.description || d.text}`);
    }
    return result?.value;
  }
}

/* ── Caminos ───────────────────────────────────────────────────────── */

async function caminoBuscar(cdp) {
  const camino = 'Buscar';
  await cdp.navigate(`${BASE}/buscar`);

  const finalUrl = await cdp.eval('location.href');
  check(camino, 'página /buscar pública (sin redirect a sign-in)', !finalUrl.includes('sign-in'), finalUrl);

  const ui = await cdp.eval(`(() => {
    const input = document.querySelector('#search-input');
    const btn = document.querySelector('#search-btn');
    const results = document.querySelector('#results');
    return { input: !!input, btn: !!btn, results: !!results };
  })()`);
  check(camino, 'UI de búsqueda presente (input, botón, contenedor resultados)',
    ui?.input && ui?.btn && ui?.results, JSON.stringify(ui));

  await cdp.eval(`(() => {
    const input = document.querySelector('#search-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(SEARCH_QUERY)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#search-btn').click();
    return true;
  })()`);

  const readSnapshot = async () => {
    const deadline = Date.now() + NAV_TIMEOUT_MS;
    let snap = null;
    for (;;) {
      snap = await cdp.eval(`(() => {
        const count = document.querySelector('#results-count')?.textContent?.trim() || '';
        const rows = [...document.querySelectorAll('#results .results-table tbody tr')];
        const importes = [...document.querySelectorAll('#results .results-table td.col-importe')].map((td) => td.textContent?.trim() || '');
        return { count, rows: rows.length, importes, table: !!document.querySelector('#results .results-table') };
      })()`);
      if (/(\d[\d.]*)\+?\s+resultados?/i.test(snap.count) && snap.rows > 0) break;
      if (/no se encontraron|sin resultados|0 resultados/i.test(snap.count)) break; // estado terminal válido → fallará el check de N≥1
      if (Date.now() > deadline) break;
      await sleep(POLL_INTERVAL_MS);
    }
    return snap;
  };

  let snapshot = await readSnapshot();
  // Ventanas de stop del ciclo de materialización (~cada 11 min, con DuckDB
  // frío tras cada restart): si la búsqueda sigue en vuelo al agotar el
  // deadline, re-verifica una vez a los 75 s (patrón alerta-web) antes de
  // dar el camino por fallado. Verificado 2026-10-12: dos FAIL seguidos en
  // producción cayeron dentro de ventanas de stop (22:14:31 y 22:20:56).
  if (/Buscando|Generando consulta/i.test(snapshot.count || '')) {
    await sleep(75_000);
    snapshot = await readSnapshot();
  }

  const m = snapshot.count.match(/(\d[\d.]*)\+?\s+resultados?/i);
  const n = m ? parseInt(m[1].replace(/\./g, ''), 10) : 0;
  check(camino, `búsqueda "${SEARCH_QUERY}" devuelve ≥1 resultado`, n > 0, `contador="${snapshot.count}" filas=${snapshot.rows}`);

  check(camino, 'tabla de resultados renderizada', snapshot.table && snapshot.rows > 0,
    `filas=${snapshot.rows}`);
  check(camino, 'importes renderizados con símbolo € y sin valores nulos',
    snapshot.importes.length > 0 && snapshot.importes.every((t) => t.includes('€') && !/null|NaN|undefined/i.test(t)),
    `importes[0..2]=${JSON.stringify(snapshot.importes.slice(0, 3))}`);
  return snapshot;
}

async function caminoPerfil(cdp) {
  const camino = 'Perfil';
  await cdp.navigate(`${BASE}/perfil/B95241154`);
  const finalUrl = await cdp.eval('location.href');

  // innerText respeta text-transform: uppercase — normalizar a minúsculas para los includes
  const text = (await cdp.eval('document.body.innerText')).toLowerCase();
  const html = await cdp.eval('document.documentElement.outerHTML');

  check(camino, 'página /perfil/B95241154 accesible', !!text && !finalUrl.includes('sign-in'), finalUrl);
  check(camino, 'bloque "Volumen total" presente', text.includes('volumen total'));
  check(camino, 'nota "importe corregido (issue #22" visible', text.includes('importe corregido (issue #22'));
  check(camino, 'importe publicado visible junto al corregido ("publicado:")', text.includes('publicado:'));
  check(camino, 'JSON-LD con volumen corregido (PropertyValue Volumen total)', html.includes('"Volumen total (EUR)"'));
  return { len: text.length };
}

async function caminoFicha(cdp) {
  const camino = 'FichaFARO';
  const url = `${BASE}/mercado/tecnologia`;
  await cdp.navigate(url);
  const finalUrl = await cdp.eval('location.href');

  const text = (await cdp.eval('document.body.innerText')).toLowerCase();
  const html = await cdp.eval('document.documentElement.outerHTML');

  check(camino, 'página /mercado/tecnologia accesible', !!text && !finalUrl.includes('sign-in'), finalUrl);
  check(camino, 'kicker "FARO · Ficha de mercado"', text.includes('faro · ficha de mercado'));
  check(camino, 'sección Concentración con HHI legible', text.includes('concentración') && text.includes('índice herfindahl–hirschman'));
  check(camino, 'tabla de datos presente', /<table[\s>]/.test(html));
  check(camino, 'grafo/datos con faro-hhi en HTML', html.includes('faro-hhi'));
  return { len: text.length };
}

/* ── main ──────────────────────────────────────────────────────────── */

let chrome;
try {
  chrome = await launchChrome();
  const ws = new WebSocket(chrome.wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket CDP error')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.openSession();

  console.log(`# e2e-caminos contra ${BASE} (chromium: ${chrome.bin}, query="${SEARCH_QUERY}")`);
  await caminoBuscar(cdp);
  await caminoPerfil(cdp);
  await caminoFicha(cdp);
} catch (err) {
  failures.push(`[infra] FAIL — ${err?.message || err}`);
  console.error(`infra error: ${err?.stack || err}`);
} finally {
  // chrome se cierra en el bloque siguiente
}

if (chrome) {
  try { chrome.child.kill('SIGKILL'); } catch {}
  try { rmSync(chrome.profile, { recursive: true, force: true }); } catch {}
}

console.log('');
if (failures.length) {
  console.log(`FALLOS (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('OK: 3 caminos E2E verdes');
process.exit(0);
