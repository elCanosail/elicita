// elicita-uptime — monitor externo de disponibilidad (Cloudflare Worker + Cron)
// Comprueba elicita.es cada 5 min desde el edge de Cloudflare.
// Alerta por Telegram tras 2 fallos consecutivos; aviso de recuperación al volver.
// Secret requerido: TELEGRAM_TOKEN (wrangler secret put TELEGRAM_TOKEN)

const CHECKS = [
  { key: "home", url: "https://elicita.es/", ok: [200] },
  { key: "dashboard", url: "https://elicita.es/dashboard", ok: [200, 302] },
];

const FAIL_THRESHOLD = 2;

async function tgSend(token, chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!r.ok) console.error("telegram error", r.status, await r.text());
}

async function runCheck(env, forceFail = false) {
  const results = [];
  for (const c of CHECKS) {
    let ok = false;
    let detail = "";
    if (forceFail) {
      ok = false;
      detail = "forzado (test)";
    } else {
      try {
        const r = await fetch(c.url, {
          redirect: "manual",
          cf: { cacheTtl: 0, cacheEverything: false },
          headers: { "user-agent": "elicita-uptime/1.0 (Cloudflare Worker)" },
          signal: AbortSignal.timeout(20000),
        });
        ok = c.ok.includes(r.status);
        detail = `HTTP ${r.status}`;
      } catch (e) {
        detail = `error: ${String(e).slice(0, 120)}`;
      }
    }
    results.push({ ...c, ok, detail });
  }
  return results;
}

export default {
  async scheduled(controller, env, ctx) {
    const results = await runCheck(env);
    const failed = results.filter((r) => !r.ok);

    for (const r of results) {
      if (r.ok) {
        const wasAlerted = await env.UPTIME_KV.get(`alerted:${r.key}`);
        await env.UPTIME_KV.put(`fails:${r.key}`, "0");
        if (wasAlerted === "1") {
          await env.UPTIME_KV.put(`alerted:${r.key}`, "0");
          await tgSend(env.TELEGRAM_TOKEN, env.CHAT_ID,
            `✅ Elicita recuperado — ${r.url} responde ${r.detail}`);
        }
      } else {
        const fails = parseInt((await env.UPTIME_KV.get(`fails:${r.key}`)) || "0", 10) + 1;
        await env.UPTIME_KV.put(`fails:${r.key}`, String(fails));
        if (fails >= FAIL_THRESHOLD && (await env.UPTIME_KV.get(`alerted:${r.key}`)) !== "1") {
          await env.UPTIME_KV.put(`alerted:${r.key}`, "1");
          await tgSend(env.TELEGRAM_TOKEN, env.CHAT_ID,
            `🔴 Elicita CAÍDO — ${r.url}\n${r.detail}\nFallos consecutivos: ${fails} (desde el edge de Cloudflare)`);
        }
      }
    }
  },

  // Endpoint manual: /status (estado), /test-fail (simula fallo, envía alerta de prueba)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/status") {
      const state = {};
      for (const c of CHECKS) {
        state[c.key] = {
          fails: await env.UPTIME_KV.get(`fails:${c.key}`),
          alerted: await env.UPTIME_KV.get(`alerted:${c.key}`),
        };
      }
      return Response.json(state);
    }
    if (url.pathname === "/test-fail") {
      ctx.waitUntil((async () => {
        const results = await runCheck(env, true);
        for (const r of results) {
          const fails = parseInt((await env.UPTIME_KV.get(`fails:${r.key}`)) || "0", 10) + 1;
          await env.UPTIME_KV.put(`fails:${r.key}`, String(fails));
          if (fails >= FAIL_THRESHOLD && (await env.UPTIME_KV.get(`alerted:${r.key}`)) !== "1") {
            await env.UPTIME_KV.put(`alerted:${r.key}`, "1");
            await tgSend(env.TELEGRAM_TOKEN, env.CHAT_ID,
              `🧪 TEST de alerta — Elicita CAÍDO — ${r.url}\n${r.detail}\nFallos consecutivos: ${fails}`);
          }
        }
      })());
      return new Response("test-fail disparado\n");
    }
    if (url.pathname === "/status-page") {
      const rows = [];
      for (const c of CHECKS) {
        const fails = parseInt((await env.UPTIME_KV.get(`fails:${c.key}`)) || "0", 10);
        const alerted = (await env.UPTIME_KV.get(`alerted:${c.key}`)) === "1";
        const down = alerted || fails >= FAIL_THRESHOLD;
        rows.push({ key: c.key, url: c.url, fails, down });
      }
      const now = new Date().toISOString().replace("T", " ").replace(/\..*$/, "");
      const rowHtml = rows.map((r) => {
        const cls = r.down ? "bad" : "ok";
        const estado = r.down ? "caído" : "operativo";
        return `<div class="row"><span class="dot ${cls}"></span>` +
          `<strong>${r.key}</strong> — ${estado}` +
          `<span class="url">${r.url} · fallos: ${r.fails}</span></div>`;
      }).join("");
      const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="300">
<title>Elicita — estado del servicio</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0b0f14;color:#e6edf3;margin:0;padding:2rem}
main{max-width:42rem;margin:0 auto}
h1{font-size:1.3rem;font-weight:600}
.row{display:flex;align-items:center;gap:.75rem;padding:.85rem 1rem;margin:.5rem 0;border-radius:.6rem;background:#161b22}
.dot{width:.9rem;height:.9rem;border-radius:50%;flex:0 0 auto}
.ok{background:#2ea043}
.bad{background:#f85149}
.url{color:#8b949e;font-size:.82rem;margin-left:auto;text-align:right}
.meta{color:#8b949e;font-size:.85rem;margin-top:1.5rem}
</style></head><body><main>
<h1>Elicita — estado del servicio</h1>
${rowHtml}
<p class="meta">Actualizado: ${now} UTC · Refresco automático cada 5 min</p>
</main></body></html>`;
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return new Response("elicita-uptime\n", { status: 200 });
  },
};
