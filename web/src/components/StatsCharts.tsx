import { useEffect, useRef, useState, useCallback } from "react";

interface StatsData {
  pipeline: Record<string, number>;
  totalRT: number;
  lastUpdate: string;
  estadoMap: Record<string, number>;
  byYear: { year: number; count: number; meur: number }[];
  byTipo: { tipo: string; count: number }[];
  topCpvs: { cpv: string; name: string; count: number }[];
  sources: { key: string; name: string; count: number; region: string }[];
  totalHistorical: number;
  totalBorme: number;
  generatedAt: string;
}

// ── Color palette ─────────────────────────────────────────────────────
const EM  = 'hsl(152, 60%, 40%)';
const EM2 = 'hsla(152, 60%, 40%, 0.7)';
const AM  = 'hsl(38, 92%, 50%)';
const AM2 = 'hsla(38, 92%, 50%, 0.7)';
const GRID = 'hsla(155, 5%, 96%, 0.04)';
const TEXT_MUTED = 'hsla(155, 5%, 55%, 0.7)';
const BG2 = 'hsl(155, 5%, 8%)';

// ── Canvas helpers ────────────────────────────────────────────────────
function setupCanvas(canvas: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width  = rect.width  * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  return { ctx, W: rect.width, H: rect.height };
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  r = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function fmtNum(n: number): string {
  if (n >= 1e9) return (n/1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n/1e3) + 'K';
  return n.toLocaleString('es');
}

// ── Chart 1: Year Area Chart ──────────────────────────────────────────
function drawYearChart(canvas: HTMLCanvasElement, data: StatsData['byYear'], progress: number) {
  const { ctx, W, H } = setupCanvas(canvas);
  const pad = { top: 30, right: 20, bottom: 36, left: 48 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;

  ctx.clearRect(0, 0, W, H);

  const maxCount = Math.max(...data.map(d => d.count));
  const maxMeur  = Math.max(...data.map(d => d.meur));
  const n = data.length;

  const xOf = (i: number) => pad.left + (i / (n - 1)) * cW;
  const yCount = (v: number) => pad.top + cH - (v / maxCount) * cH;
  const yMeur  = (v: number) => pad.top + cH - (v / maxMeur)  * cH;

  // Grid lines
  ctx.font = `9px "JetBrains Mono", monospace`;
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (i / 4) * cH;
    const v = maxCount * (1 - i / 4);
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cW, y); ctx.stroke();
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText(fmtNum(v), pad.left - 4, y + 3);
  }

  // X labels
  ctx.textAlign = 'center';
  ctx.fillStyle = TEXT_MUTED;
  ctx.font = `9px "JetBrains Mono", monospace`;
  data.forEach((d, i) => {
    ctx.fillText(String(d.year), xOf(i), H - 6);
  });

  // Animate up to progress
  const pItems = Math.ceil(progress * (n - 1));
  const pFrac  = (progress * (n - 1)) - Math.floor(progress * (n - 1));

  // ── Meur area (amber, behind) ───────────────────────────────────
  if (pItems > 0) {
    ctx.beginPath();
    ctx.moveTo(xOf(0), yMeur(data[0].meur));
    for (let i = 1; i < pItems; i++) {
      const x0 = xOf(i - 1), y0 = yMeur(data[i-1].meur);
      const x1 = xOf(i),     y1 = yMeur(data[i].meur);
      const cx = (x0 + x1) / 2;
      ctx.bezierCurveTo(cx, y0, cx, y1, x1, y1);
    }
    if (pItems < n) {
      const x0 = xOf(pItems - 1), y0 = yMeur(data[pItems-1].meur);
      const x1 = xOf(pItems),     y1 = yMeur(data[pItems].meur);
      const cx = (x0 + x1) / 2;
      const ex = x0 + (x1 - x0) * pFrac;
      const ey = y0 + (y1 - y0) * pFrac;
      ctx.bezierCurveTo(cx, y0, cx, ey, ex, ey);
    }
    const lastX = pItems < n ? xOf(pItems - 1) + (xOf(pItems) - xOf(pItems-1)) * pFrac : xOf(n-1);
    ctx.lineTo(lastX, pad.top + cH);
    ctx.lineTo(xOf(0), pad.top + cH);
    ctx.closePath();
    const amGrad = ctx.createLinearGradient(0, pad.top, 0, pad.top + cH);
    amGrad.addColorStop(0, 'hsl(var(--warning) / 0.18)');
    amGrad.addColorStop(1, 'hsl(var(--warning) / 0.02)');
    ctx.fillStyle = amGrad;
    ctx.fill();
  }

  // ── Count area (emerald, front) ─────────────────────────────────
  if (pItems > 0) {
    ctx.beginPath();
    ctx.moveTo(xOf(0), yCount(data[0].count));
    for (let i = 1; i < pItems; i++) {
      const x0 = xOf(i-1), y0 = yCount(data[i-1].count);
      const x1 = xOf(i),   y1 = yCount(data[i].count);
      const cx = (x0 + x1) / 2;
      ctx.bezierCurveTo(cx, y0, cx, y1, x1, y1);
    }
    if (pItems < n) {
      const x0 = xOf(pItems-1), y0 = yCount(data[pItems-1].count);
      const x1 = xOf(pItems),   y1 = yCount(data[pItems].count);
      const cx = (x0 + x1) / 2;
      const ex = x0 + (x1-x0)*pFrac;
      const ey = y0 + (y1-y0)*pFrac;
      ctx.bezierCurveTo(cx, y0, cx, ey, ex, ey);
    }
    const lastX = pItems < n ? xOf(pItems-1) + (xOf(pItems)-xOf(pItems-1))*pFrac : xOf(n-1);
    ctx.lineTo(lastX, pad.top + cH);
    ctx.lineTo(xOf(0), pad.top + cH);
    ctx.closePath();
    const emGrad = ctx.createLinearGradient(0, pad.top, 0, pad.top + cH);
    emGrad.addColorStop(0, 'hsl(var(--primary) / 0.25)');
    emGrad.addColorStop(1, 'hsl(var(--primary) / 0.02)');
    ctx.fillStyle = emGrad;
    ctx.fill();

    // Line stroke
    ctx.beginPath();
    ctx.moveTo(xOf(0), yCount(data[0].count));
    for (let i = 1; i < pItems; i++) {
      const x0 = xOf(i-1), y0 = yCount(data[i-1].count);
      const x1 = xOf(i),   y1 = yCount(data[i].count);
      const cx = (x0+x1)/2;
      ctx.bezierCurveTo(cx, y0, cx, y1, x1, y1);
    }
    if (pItems < n) {
      const x0 = xOf(pItems-1), y0 = yCount(data[pItems-1].count);
      const x1 = xOf(pItems),   y1 = yCount(data[pItems].count);
      const cx = (x0+x1)/2;
      ctx.bezierCurveTo(cx, y0, cx, y0+(y1-y0)*pFrac, x0+(x1-x0)*pFrac, y0+(y1-y0)*pFrac);
    }
    ctx.strokeStyle = EM;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Tooltip dot at last visible point
  if (progress > 0) {
    const li = Math.min(Math.floor(progress * (n-1)), n-1);
    const lx = xOf(li), ly = yCount(data[li].count);
    ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI*2);
    ctx.fillStyle = EM; ctx.fill();
    ctx.strokeStyle = BG2; ctx.lineWidth = 2; ctx.stroke();

    // Value label
    ctx.font = `bold 10px "JetBrains Mono", monospace`;
    ctx.textAlign = lx > W/2 ? 'right' : 'left';
    ctx.fillStyle = EM;
    ctx.fillText(fmtNum(data[li].count), lx + (lx > W/2 ? -8 : 8), ly - 8);
  }
}

// ── Chart 2: Horizontal bar - CPV ─────────────────────────────────────
function drawCpvChart(canvas: HTMLCanvasElement, data: StatsData['topCpvs'], progress: number) {
  const { ctx, W, H } = setupCanvas(canvas);
  const n = data.length;
  const pad = { top: 10, right: 60, bottom: 10, left: 140 };
  const cW = W - pad.left - pad.right;
  const rowH = (H - pad.top - pad.bottom) / n;
  const barH = Math.min(rowH * 0.45, 12);
  const maxVal = data[0].count;

  ctx.clearRect(0, 0, W, H);
  ctx.font = `10px "JetBrains Mono", monospace`;

  data.forEach((d, i) => {
    const y = pad.top + i * rowH + rowH / 2;
    const barW = (d.count / maxVal) * cW * progress;

    // Label
    ctx.fillStyle = TEXT_MUTED;
    ctx.textAlign = 'right';
    ctx.font = `10px "JetBrains Mono", monospace`;
    ctx.fillText(d.name, pad.left - 8, y + 4);

    // Track
    roundedRect(ctx, pad.left, y - barH/2, cW, barH, 3);
    ctx.fillStyle = 'hsla(155, 5%, 96%, 0.04)';
    ctx.fill();

    // Fill
    if (barW > 0) {
      roundedRect(ctx, pad.left, y - barH/2, barW, barH, 3);
      const g = ctx.createLinearGradient(pad.left, 0, pad.left + cW, 0);
      g.addColorStop(0, EM);
      g.addColorStop(1, EM2);
      ctx.fillStyle = g;
      ctx.fill();
    }

    // Value
    ctx.fillStyle = TEXT_MUTED;
    ctx.textAlign = 'left';
    ctx.font = `9px "JetBrains Mono", monospace`;
    ctx.fillText(fmtNum(d.count), pad.left + cW + 6, y + 3);
  });
}

// ── Chart 3: Donut - Tipo contrato ────────────────────────────────────
const TIPO_COLORS = [EM, EM2, 'hsla(152, 60%, 40%, 0.5)', 'hsla(152, 60%, 40%, 0.8)', 'hsla(152, 60%, 40%, 0.6)'];

function drawDonut(canvas: HTMLCanvasElement, data: StatsData['byTipo'], progress: number) {
  const { ctx, W, H } = setupCanvas(canvas);
  ctx.clearRect(0, 0, W, H);

  const total = data.reduce((s, d) => s + d.count, 0);
  const cx = W * 0.38, cy = H / 2;
  const outerR = Math.min(cx, cy) * 0.82;
  const innerR = outerR * 0.58;
  const gap = 0.025;

  let angle = -Math.PI / 2;
  const slices = data.map(d => ({ ...d, pct: d.count / total }));

  slices.forEach((s, i) => {
    const sweep = s.pct * Math.PI * 2 * progress;
    if (sweep < 0.001) return;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, outerR, angle + gap, angle + sweep - gap);
    ctx.arc(cx, cy, innerR, angle + sweep - gap, angle + gap, true);
    ctx.closePath();
    ctx.fillStyle = TIPO_COLORS[i % TIPO_COLORS.length];
    ctx.fill();
    angle += sweep;
  });

  // Center label
  if (progress > 0.5) {
    ctx.textAlign = 'center';
    ctx.font = `bold 18px "JetBrains Mono", monospace`;
    ctx.fillStyle = 'hsl(155, 5%, 96%)';
    ctx.fillText(fmtNum(total), cx, cy + 6);
    ctx.font = `9px "JetBrains Mono", monospace`;
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText('CONTRATOS', cx, cy + 20);
  }

  // Legend (right side)
  const legendX = W * 0.68;
  let legendY = cy - (slices.length * 22) / 2 + 8;
  ctx.textAlign = 'left';
  slices.forEach((s, i) => {
    const pct = (s.pct * 100).toFixed(0) + '%';
    // Dot
    ctx.beginPath(); ctx.arc(legendX, legendY, 4, 0, Math.PI*2);
    ctx.fillStyle = TIPO_COLORS[i % TIPO_COLORS.length]; ctx.fill();
    ctx.font = `10px "JetBrains Mono", monospace`;
    ctx.fillStyle = 'hsl(155, 5%, 96%)';
    ctx.fillText(s.tipo, legendX + 10, legendY + 4);
    ctx.font = `9px "JetBrains Mono", monospace`;
    ctx.fillStyle = TIPO_COLORS[i % TIPO_COLORS.length];
    ctx.textAlign = 'right';
    ctx.fillText(pct, W - 8, legendY + 4);
    ctx.textAlign = 'left';
    legendY += 22;
  });
}

// ── Chart 4: Pipeline bar chart ────────────────────────────────────────
const PIPELINE_META: Record<string, { name: string; flag: string }> = {
  madrid_cm:   { name: 'Madrid CM',   flag: '🏛️' },
  euskadi:     { name: 'Euskadi',      flag: '🌿' },
  placsp:      { name: 'PLACSP',       flag: '🇪🇸' },
  madrid_ayto: { name: 'Madrid Ayto', flag: '🏙️' },
  dogv:        { name: 'Valencia',    flag: '🍊' },
  galicia:     { name: 'Galicia',     flag: '🌊' },
  doga:        { name: 'Galicia BOG', flag: '📋' },
  catalunya:   { name: 'Catalunya',   flag: '🔴' },
  place:       { name: 'PLACE',       flag: '📡' },
  ted:         { name: 'TED EU',      flag: '🇪🇺' },
  boe:         { name: 'BOE',         flag: '📜' },
  andalucia:   { name: 'Andalucía',   flag: '☀️' },
  asturias:    { name: 'Asturias',     flag: '⛰️' },
};

function drawPipeline(canvas: HTMLCanvasElement, pipeline: Record<string, number>, progress: number) {
  const { ctx, W, H } = setupCanvas(canvas);
  ctx.clearRect(0, 0, W, H);

  const entries = Object.entries(pipeline)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (!entries.length) return;

  const n = entries.length;
  const pad = { top: 10, right: 60, bottom: 10, left: 100 };
  const cW = W - pad.left - pad.right;
  const rowH = (H - pad.top - pad.bottom) / n;
  const barH = Math.min(rowH * 0.5, 14);
  const maxVal = entries[0][1];

  entries.forEach(([key, val], i) => {
    const y = pad.top + i * rowH + rowH / 2;
    const meta = PIPELINE_META[key] || { name: key, flag: '📄' };
    const barW = (val / maxVal) * cW * progress;

    // Label
    ctx.textAlign = 'right';
    ctx.font = `10px "JetBrains Mono", monospace`;
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText(`${meta.flag} ${meta.name}`, pad.left - 6, y + 4);

    // Track
    roundedRect(ctx, pad.left, y - barH/2, cW, barH, 3);
    ctx.fillStyle = 'hsla(155, 5%, 96%, 0.04)'; ctx.fill();

    // Fill
    if (barW > 0) {
      roundedRect(ctx, pad.left, y - barH/2, barW, barH, 3);
      const pct = val / maxVal;
      const g = ctx.createLinearGradient(pad.left, 0, pad.left + cW, 0);
      g.addColorStop(0, pct > 0.5 ? EM : EM2);
      g.addColorStop(1, pct > 0.5 ? EM2 : 'hsla(152, 60%, 40%, 0.7)');
      ctx.fillStyle = g; ctx.fill();
    }

    // Value
    ctx.textAlign = 'left';
    ctx.font = `9px "JetBrains Mono", monospace`;
    ctx.fillStyle = EM;
    ctx.fillText(val.toLocaleString('es-ES'), pad.left + cW + 6, y + 3);
  });
}

// ── Easing ────────────────────────────────────────────────────────────
function easeOutQuart(t: number) { return 1 - Math.pow(1 - t, 4); }

// ── Main component ────────────────────────────────────────────────────
export default function StatsCharts() {
  const [data, setData]   = useState<StatsData | null>(null);
  const [error, setError] = useState(false);
  const [age, setAge]     = useState('');

  const yearRef  = useRef<HTMLCanvasElement>(null);
  const cpvRef   = useRef<HTMLCanvasElement>(null);
  const donutRef = useRef<HTMLCanvasElement>(null);
  const pipeRef  = useRef<HTMLCanvasElement>(null);

  const progressRef = useRef({ year: 0, cpv: 0, donut: 0, pipe: 0 });
  const rafRef      = useRef<number>(0);
  const dataRef     = useRef<StatsData | null>(null);
  const lastFetch   = useRef(0);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/stats');
      const json: StatsData = await res.json();
      setData(json);
      dataRef.current = json;

      // Reset progress for animated re-draw
      progressRef.current = { year: 0, cpv: 0, donut: 0, pipe: 0 };
      lastFetch.current = Date.now();
    } catch {
      setError(true);
    }
  }, []);

  // Age display
  useEffect(() => {
    const tick = () => {
      if (!lastFetch.current) return;
      const mins = Math.floor((Date.now() - lastFetch.current) / 60000);
      setAge(mins < 1 ? 'ahora mismo' : `hace ${mins} min`);
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, []);

  // Auto-refresh every 5 minutes
  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [fetchData]);

  // Animation loop
  useEffect(() => {
    const SPEED = 0.018;
    const loop = () => {
      const p = progressRef.current;
      const d = dataRef.current;
      if (!d) { rafRef.current = requestAnimationFrame(loop); return; }

      let dirty = false;
      if (p.year < 1) { p.year = Math.min(1, p.year + SPEED * 0.7); dirty = true; }
      if (p.cpv  < 1) { p.cpv  = Math.min(1, p.cpv  + SPEED); dirty = true; }
      if (p.donut< 1) { p.donut= Math.min(1, p.donut+ SPEED * 0.8); dirty = true; }
      if (p.pipe < 1) { p.pipe = Math.min(1, p.pipe + SPEED); dirty = true; }

      if (dirty) {
        if (yearRef.current)  drawYearChart(yearRef.current,  d.byYear,  easeOutQuart(p.year));
        if (cpvRef.current)   drawCpvChart(cpvRef.current,    d.topCpvs, easeOutQuart(p.cpv));
        if (donutRef.current) drawDonut(donutRef.current,     d.byTipo,  easeOutQuart(p.donut));
        if (pipeRef.current)  drawPipeline(pipeRef.current,   d.pipeline,easeOutQuart(p.pipe));
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // Redraw on resize
  useEffect(() => {
    const onResize = () => {
      const d = dataRef.current;
      const p = progressRef.current;
      if (!d) return;
      if (yearRef.current)  drawYearChart(yearRef.current,  d.byYear,  easeOutQuart(p.year));
      if (cpvRef.current)   drawCpvChart(cpvRef.current,    d.topCpvs, easeOutQuart(p.cpv));
      if (donutRef.current) drawDonut(donutRef.current,     d.byTipo,  easeOutQuart(p.donut));
      if (pipeRef.current)  drawPipeline(pipeRef.current,   d.pipeline,easeOutQuart(p.pipe));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const label: React.CSSProperties = {
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: '.68rem',
    letterSpacing: '.12em',
    textTransform: 'uppercase' as const,
    color: EM,
    marginBottom: '.5rem',
  };

  const subtitle: React.CSSProperties = {
    fontSize: '.75rem',
    color: 'hsl(var(--muted-foreground) / 0.7)',
    marginBottom: '1rem',
  };

  if (error) return (
    <div className="text-[hsl(var(--muted-foreground)/0.7)] text-[0.85rem] p-8 text-center">
      Error cargando estadísticas. Recarga la página.
    </div>
  );

  return (
    <div className="flex flex-col gap-px">

      {/* Header live indicator */}
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-2">
          <div
            className="rounded-full"
            style={{
              width: 6, height: 6,
              background: EM,
              boxShadow: `0 0 6px ${EM}`,
              animation: 'pulse-dot 2s infinite',
            }}
          />
          <span className="font-[JetBrains_Mono] text-[0.7rem] text-[hsl(var(--primary))]">
            LIVE
          </span>
          <span className="text-[0.72rem] text-[hsl(var(--muted-foreground))]">
            · actualizado {age || '…'} · auto-refresco 5 min
          </span>
        </div>
        {data && (
          <span className="font-[JetBrains_Mono] text-[0.68rem] text-[hsl(var(--muted-foreground))]">
            {data.totalRT.toLocaleString('es-ES')} contratos activos
          </span>
        )}
      </div>

      {/* Row 1: Year chart (full width) */}
      <div className="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-[10px] p-5 mb-4">
        <div style={label}>Evolución histórica 2015–2025</div>
        <div style={subtitle}>
          Contratos publicados por año&nbsp;·&nbsp;
          <span style={{ color: EM }}>── nº contratos</span>&nbsp;&nbsp;
          <span style={{ color: AM }}>── valor (M€)</span>
        </div>
        <canvas ref={yearRef} className="w-full block" style={{ height: 200 }} />
      </div>

      {/* Row 2: CPV + Donut side by side */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div className="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-[10px] p-5">
          <div style={label}>Top categorías CPV</div>
          <div style={subtitle}>Contratos por código europeo de clasificación</div>
          <canvas ref={cpvRef} className="w-full block" style={{ height: 220 }} />
        </div>

        <div className="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-[10px] p-5">
          <div style={label}>Por tipo de contrato</div>
          <div style={subtitle}>Distribución del dataset PLACSP nacional</div>
          <canvas ref={donutRef} className="w-full block" style={{ height: 220 }} />
        </div>
      </div>

      {/* Row 3: Pipeline (full width) */}
      <div className="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-[10px] p-5">
        <div className="flex justify-between items-start mb-[0.3rem]">
          <div style={label}>Pipeline tiempo real · últimos 30 días</div>
          {data?.lastUpdate && (
            <span className="font-[JetBrains_Mono] text-[0.65rem] text-[hsl(var(--muted-foreground))]">
              {new Date(data.lastUpdate).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        <div style={subtitle}>Contratos indexados por conector · ciclo de actualización 4h</div>
        <canvas ref={pipeRef} className="w-full block" style={{ height: 220 }} />
      </div>

      <style>{`
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; }
          50% { opacity: .3; }
        }
      `}</style>
    </div>
  );
}
