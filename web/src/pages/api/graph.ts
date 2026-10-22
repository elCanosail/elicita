import type { APIRoute } from 'astro';
import { query } from '../../lib/duckdb';
import { requireAuth } from '../../lib/api-auth';

function toNum(v: any): number {
  if (typeof v === 'bigint') return Number(v);
  return Number(v) || 0;
}

export const GET: APIRoute = async ({ url, locals }) => {
  const { error } = requireAuth(locals);
  if (error) return error;
  const q = url.searchParams.get('q')?.trim() || '';
  const type = url.searchParams.get('type')?.trim() || '';
  const cpv = url.searchParams.get('cpv')?.trim() || '';
  const year = url.searchParams.get('year')?.trim() || '';
  const yearEnd = url.searchParams.get('year_end')?.trim() || '';
  const expand = url.searchParams.get('expand')?.trim() === '1';
  const levelParam = url.searchParams.get('level')?.trim() || '';

  if (!q || !type) {
    return new Response(JSON.stringify({ error: 'Parámetros requeridos: q, type' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Multi-division CPV filter: accepts comma-separated 2-digit prefixes ("48,72"),
  // each matched as a LIKE prefix. Prepared parameters, no interpolation.
  const cpvCodes = cpv
    .split(',')
    .map((c) => c.replace(/[^0-9]/g, ''))
    .filter((c) => c.length >= 2)
    .slice(0, 6);
  const safeYear = (s: string): number | null => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n >= 1990 && n <= 2100 ? n : null;
  };
  const y = safeYear(year);
  const yEnd = safeYear(yearEnd);

  const filtroCpv = (): string =>
    cpvCodes.length ? ` AND (${cpvCodes.map(() => `cpv LIKE ?`).join(' OR ')})` : '';
  const filtroYear = (): string => {
    if (y !== null && yEnd !== null) return ` AND fecha_publicacion >= DATE ? AND fecha_publicacion < DATE ?`;
    if (y !== null) return ` AND fecha_publicacion >= DATE ?`;
    if (yEnd !== null) return ` AND fecha_publicacion < DATE ?`;
    return '';
  };
  const cpvParams = (): any[] => cpvCodes.map((c) => `${c}%`);
  const yearParams = (): any[] => {
    if (y !== null && yEnd !== null) return [`${y}-01-01`, `${yEnd + 1}-01-01`];
    if (y !== null) return [`${y}-01-01`];
    if (yEnd !== null) return [`${yEnd + 1}-01-01`];
    return [];
  };
  const extraClause = (): { clause: string; params: any[] } => {
    const clause = `${filtroCpv()}${filtroYear()}`;
    const params = [...cpvParams(), ...yearParams()];
    return { clause, params };
  };

  try {
    if (expand && levelParam === '3') {
      // ── Level 3 expansion: given a non-center node, return only new nodes/edges ──
      if (type === 'adjudicatario') {
        // Step A: other organisms where this adjudicatario works (top 15)
        const orgRows = await query(`SELECT organismo, COUNT(*) as contratos, SUM(importe_adjudicacion) as volumen
           FROM contratos_vivos
           WHERE nif_adjudicatario = ?${filtroCpv()}${filtroYear()}
           GROUP BY organismo
           ORDER BY volumen DESC
           LIMIT 15`,
          [q, ...cpvParams(), ...yearParams()]
        );
        const topOrgs = orgRows.map(r => r.organismo);

        // Step B: other adjudicatarios in those organisms (top 20)
        let newAdjRows: any[] = [];
        if (topOrgs.length > 0) {
          const placeholders = topOrgs.map(() => '?').join(',');
          newAdjRows = await query(`SELECT nif_adjudicatario, adjudicatario, organismo,
                    COUNT(*) as contratos, SUM(importe_adjudicacion) as volumen
             FROM contratos_vivos
             WHERE organismo IN (${placeholders}) AND nif_adjudicatario != ?${filtroCpv()}${filtroYear()}
             GROUP BY nif_adjudicatario, adjudicatario, organismo
             ORDER BY volumen DESC
             LIMIT 20`,
            [...topOrgs, q, ...cpvParams(), ...yearParams()]
          );
        }

        const newNodes: any[] = [];
        const nodesById = new Map<string, any>();
        for (const org of orgRows) {
          const id = `org:${org.organismo}`;
          if (nodesById.has(id)) continue;
          const node = { id, name: org.organismo, type: 'organismo', contratos: toNum(org.contratos), volumen: toNum(org.volumen) };
          nodesById.set(id, node);
          newNodes.push(node);
        }
        const adjTotals = new Map<string, { contratos: number; volumen: number }>();
        for (const row of newAdjRows) {
          const id = row.nif_adjudicatario || `adj:${row.adjudicatario}`;
          if (!nodesById.has(id)) {
            const node = { id, name: row.adjudicatario, type: 'adjudicatario', contratos: 0, volumen: 0 };
            nodesById.set(id, node);
            newNodes.push(node);
          }
          const t = adjTotals.get(id) || { contratos: 0, volumen: 0 };
          t.contratos += toNum(row.contratos);
          t.volumen += toNum(row.volumen);
          adjTotals.set(id, t);
        }
        for (const [id, t] of adjTotals) {
          const node = nodesById.get(id);
          if (node) { node.contratos = t.contratos; node.volumen = t.volumen; }
        }

        const edgeKeySet = new Set<string>();
        const newEdges: any[] = [];
        for (const e of orgRows) {
          const key = `${q}|||org:${e.organismo}`;
          if (edgeKeySet.has(key)) continue;
          edgeKeySet.add(key);
          newEdges.push({ source: q, target: `org:${e.organismo}`, contratos: toNum(e.contratos), volumen: toNum(e.volumen) });
        }
        for (const row of newAdjRows) {
          const adjId = row.nif_adjudicatario || `adj:${row.adjudicatario}`;
          const key = `${adjId}|||org:${row.organismo}`;
          if (edgeKeySet.has(key)) continue;
          edgeKeySet.add(key);
          newEdges.push({ source: adjId, target: `org:${row.organismo}`, contratos: toNum(row.contratos), volumen: toNum(row.volumen) });
        }

        return new Response(JSON.stringify({ newNodes, newEdges }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      } else if (type === 'organismo') {
        // Step A: other adjudicatarios that contract with this organism (top 15)
        const adjRows = await query(`SELECT nif_adjudicatario, adjudicatario, COUNT(*) as contratos, SUM(importe_adjudicacion) as volumen
           FROM contratos_vivos
           WHERE organismo = ?${filtroCpv()}${filtroYear()}
           GROUP BY nif_adjudicatario, adjudicatario
           ORDER BY volumen DESC
           LIMIT 15`,
          [q, ...cpvParams(), ...yearParams()]
        );
        const topAdjs = adjRows.map(r => r.nif_adjudicatario).filter(Boolean);

        // Step B: other organisms where those adjudicatarios contract (top 20)
        let newOrgRows: any[] = [];
        if (topAdjs.length > 0) {
          const placeholders = topAdjs.map(() => '?').join(',');
          newOrgRows = await query(`SELECT organismo, nif_adjudicatario, COUNT(*) as contratos, SUM(importe_adjudicacion) as volumen
             FROM contratos_vivos
             WHERE nif_adjudicatario IN (${placeholders}) AND organismo != ?${filtroCpv()}${filtroYear()}
             GROUP BY organismo, nif_adjudicatario
             ORDER BY volumen DESC
             LIMIT 20`,
            [...topAdjs, q, ...cpvParams(), ...yearParams()]
          );
        }

        const newNodes: any[] = [];
        const nodesById = new Map<string, any>();
        for (const adj of adjRows) {
          const id = adj.nif_adjudicatario || `adj:${adj.adjudicatario}`;
          if (nodesById.has(id)) continue;
          const node = { id, name: adj.adjudicatario, type: 'adjudicatario', contratos: toNum(adj.contratos), volumen: toNum(adj.volumen) };
          nodesById.set(id, node);
          newNodes.push(node);
        }
        const orgTotals = new Map<string, { contratos: number; volumen: number }>();
        for (const row of newOrgRows) {
          const id = `org:${row.organismo}`;
          if (!nodesById.has(id)) {
            const node = { id, name: row.organismo, type: 'organismo', contratos: 0, volumen: 0 };
            nodesById.set(id, node);
            newNodes.push(node);
          }
          const t = orgTotals.get(id) || { contratos: 0, volumen: 0 };
          t.contratos += toNum(row.contratos);
          t.volumen += toNum(row.volumen);
          orgTotals.set(id, t);
        }
        for (const [id, t] of orgTotals) {
          const node = nodesById.get(id);
          if (node) { node.contratos = t.contratos; node.volumen = t.volumen; }
        }

        const edgeKeySet = new Set<string>();
        const newEdges: any[] = [];
        for (const adj of adjRows) {
          const adjId = adj.nif_adjudicatario || `adj:${adj.adjudicatario}`;
          const key = `${q}|||${adjId}`;
          if (edgeKeySet.has(key)) continue;
          edgeKeySet.add(key);
          newEdges.push({ source: q, target: adjId, contratos: toNum(adj.contratos), volumen: toNum(adj.volumen) });
        }
        for (const row of newOrgRows) {
          const adjId = row.nif_adjudicatario || `adj:${row.adjudicatario}`;
          const orgId = `org:${row.organismo}`;
          const key = `${adjId}|||${orgId}`;
          if (edgeKeySet.has(key)) continue;
          edgeKeySet.add(key);
          newEdges.push({ source: adjId, target: orgId, contratos: toNum(row.contratos), volumen: toNum(row.volumen) });
        }

        return new Response(JSON.stringify({ newNodes, newEdges }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (type === 'adjudicatario') {
      const { clause: filterClause, params: filterParams } = extraClause();

      // 1. Find the company
      const companyRows = await query(`SELECT DISTINCT adjudicatario, nif_adjudicatario
         FROM contratos_vivos
         WHERE (nif_adjudicatario = ? OR adjudicatario ILIKE ?)${filterClause}
         LIMIT 1`,
        [q, q, ...filterParams]
      );

      if (!companyRows.length) {
        return new Response(JSON.stringify({ error: 'Empresa no encontrada' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const company = companyRows[0];
      const nif = company.nif_adjudicatario;
      const companyName = company.adjudicatario;

      // 2. Get organisms for this company
      const orgRows = await query(`SELECT organismo, COUNT(*) as contratos, SUM(importe_adjudicacion) as volumen
         FROM contratos_vivos
         WHERE nif_adjudicatario = ?${filterClause}
         GROUP BY organismo
         ORDER BY volumen DESC
         LIMIT 30`,
        [nif, ...filterParams]
      );

      // Top 10 organisms for level 2
      const top10orgs = orgRows.slice(0, 10).map((r: any) => r.organismo);

      // 3. Level 2: other adjudicatarios in same organisms
      let level2Rows: any[] = [];
      if (top10orgs.length > 0) {
        const placeholders = top10orgs.map(() => '?').join(',');
        level2Rows = await query(`SELECT nif_adjudicatario, adjudicatario, organismo,
                  COUNT(*) as contratos, SUM(importe_adjudicacion) as volumen
           FROM contratos_vivos
           WHERE organismo IN (${placeholders}) AND nif_adjudicatario != ?${filterClause}
           GROUP BY nif_adjudicatario, adjudicatario, organismo
           ORDER BY volumen DESC
           LIMIT 50`,
          [...top10orgs, nif, ...filterParams]
        );
      }

      // Pre-build node maps to know which nodes to enrich
      const nodesMap = new Map<string, any>();
      const edgesMap = new Map<string, any>();

      nodesMap.set(nif, {
        id: nif,
        name: companyName,
        type: 'adjudicatario',
        contratos: toNum(orgRows.reduce((s: number, r: any) => s + toNum(r.contratos), 0)),
        volumen: toNum(orgRows.reduce((s: number, r: any) => s + toNum(r.volumen), 0)),
      });

      // Organism nodes + edges from center
      for (const org of orgRows) {
        const orgId = `org:${org.organismo}`;
        nodesMap.set(orgId, {
          id: orgId,
          name: org.organismo,
          type: 'organismo',
          contratos: toNum(org.contratos),
          volumen: toNum(org.volumen),
        });
        const eKey = `${nif}|||${orgId}`;
        if (!edgesMap.has(eKey)) {
          edgesMap.set(eKey, {
            source: nif,
            target: orgId,
            contratos: toNum(org.contratos),
            volumen: toNum(org.volumen),
          });
        }
      }

      // Collect NIFs and organism names present in the graph for metric queries
      const adjNifs = new Set<string>();
      const orgNames = new Set<string>();
      for (const n of nodesMap.values()) {
        if (n.type === 'adjudicatario') adjNifs.add(n.id);
        else if (n.type === 'organismo') orgNames.add(n.name);
      }

      // monopolio_pct for each adjudicatario vs each organismo in graph
      if (adjNifs.size > 0 && orgNames.size > 0) {
        const adjList = Array.from(adjNifs);
        const orgList = Array.from(orgNames);
        const adjPlace = adjList.map(() => '?').join(',');
        const orgPlace = orgList.map(() => '?').join(',');
        const monoRows = await query(`SELECT nif_adjudicatario, organismo,
                  SUM(importe_adjudicacion) as vol_empresa,
                  (SELECT SUM(importe_adjudicacion) FROM contratos_vivos WHERE organismo = t1.organismo${filterClause}) as vol_total
           FROM contratos_vivos t1
           WHERE nif_adjudicatario IN (${adjPlace}) AND organismo IN (${orgPlace})${filterClause}
           GROUP BY nif_adjudicatario, organismo`,
          [...adjList, ...orgList, ...filterParams, ...filterParams]
        );
        for (const r of monoRows) {
          const adjId = r.nif_adjudicatario;
          const orgId = `org:${r.organismo}`;
          const volEmpresa = toNum(r.vol_empresa);
          const volTotal = toNum(r.vol_total);
          const pct = volTotal > 0 ? (volEmpresa / volTotal) * 100 : 0;
          const adjNode = nodesMap.get(adjId);
          if (adjNode && adjNode.type === 'adjudicatario') {
            // Store highest monopolio_pct across organisms in graph
            if (!adjNode.monopolio_pct || pct > adjNode.monopolio_pct) {
              adjNode.monopolio_pct = Number(pct.toFixed(2));
              adjNode._monopolio_org = r.organismo;
            }
          }
          const orgNode = nodesMap.get(orgId);
          if (orgNode && orgNode.type === 'organismo') {
            // Track top adjudicatario share for the organism
            if (!orgNode.dominancia_pct || pct > orgNode.dominancia_pct) {
              orgNode.dominancia_pct = Number(pct.toFixed(2));
              orgNode._dominancia_nif = adjId;
            }
          }
        }
      }

      // concentracion_pct for each adjudicatario: share from top organismo
      if (adjNifs.size > 0) {
        const adjList = Array.from(adjNifs);
        const adjPlace = adjList.map(() => '?').join(',');
        const concRows = await query(`SELECT nif_adjudicatario,
                  organismo,
                  SUM(importe_adjudicacion) as volumen
           FROM contratos_vivos
           WHERE nif_adjudicatario IN (${adjPlace})${filterClause}
           GROUP BY nif_adjudicatario, organismo
           ORDER BY nif_adjudicatario, volumen DESC`,
          [...adjList, ...filterParams]
        );
        const concByAdj = new Map<string, { topVol: number; totalVol: number }>();
        for (const r of concRows) {
          const id = r.nif_adjudicatario;
          const v = toNum(r.volumen);
          let cur = concByAdj.get(id);
          if (!cur) {
            cur = { topVol: v, totalVol: v };
          } else {
            cur.totalVol += v;
          }
          concByAdj.set(id, cur);
        }
        for (const [id, cur] of concByAdj) {
          const node = nodesMap.get(id);
          if (node && node.type === 'adjudicatario') {
            const pct = cur.totalVol > 0 ? (cur.topVol / cur.totalVol) * 100 : 0;
            node.concentracion_pct = Number(pct.toFixed(2));
          }
        }
      }

      // Level 2 adjudicatarios
      const l2OrgTotals = new Map<string, { contratos: number; volumen: number }>();
      for (const row of level2Rows) {
        const adjId = row.nif_adjudicatario || `adj:${row.adjudicatario}`;
        const orgId = `org:${row.organismo}`;

        if (!nodesMap.has(adjId)) {
          nodesMap.set(adjId, {
            id: adjId,
            name: row.adjudicatario,
            type: 'adjudicatario',
            contratos: 0,
            volumen: 0,
          });
        }
        // Accumulate totals
        const cur = l2OrgTotals.get(adjId) || { contratos: 0, volumen: 0 };
        cur.contratos += toNum(row.contratos);
        cur.volumen += toNum(row.volumen);
        l2OrgTotals.set(adjId, cur);

        const eKey = `${adjId}|||${orgId}`;
        if (!edgesMap.has(eKey) && nodesMap.has(orgId)) {
          edgesMap.set(eKey, {
            source: adjId,
            target: orgId,
            contratos: toNum(row.contratos),
            volumen: toNum(row.volumen),
          });
        }
      }

      // Update L2 node totals
      for (const [adjId, totals] of l2OrgTotals) {
        const node = nodesMap.get(adjId);
        if (node) {
          node.contratos = totals.contratos;
          node.volumen = totals.volumen;
        }
      }

      return new Response(JSON.stringify({
        center: { id: nif, name: companyName, type: 'adjudicatario' },
        nodes: Array.from(nodesMap.values()),
        edges: Array.from(edgesMap.values()),
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600',
        },
      });

    } else if (type === 'organismo') {
      const { clause: filterClauseOrg, params: filterParamsOrg } = extraClause();

      // 1. Get top adjudicatarios for this organism
      const adjRows = await query(`SELECT nif_adjudicatario, adjudicatario, COUNT(*) as contratos, SUM(importe_adjudicacion) as volumen
         FROM contratos_vivos
         WHERE organismo = ?${filterClauseOrg}
         GROUP BY nif_adjudicatario, adjudicatario
         ORDER BY volumen DESC
         LIMIT 30`,
        [q, ...filterParamsOrg]
      );

      // Top 10 adjudicatarios for level 2
      const top10adjs = adjRows
        .slice(0, 10)
        .map((r: any) => r.nif_adjudicatario)
        .filter(Boolean);

      // 2. Level 2: other organisms where top adjudicatarios operate
      let level2Rows: any[] = [];
      if (top10adjs.length > 0) {
        const placeholders = top10adjs.map(() => '?').join(',');
        level2Rows = await query(`SELECT organismo, nif_adjudicatario, COUNT(*) as contratos, SUM(importe_adjudicacion) as volumen
           FROM contratos_vivos
           WHERE nif_adjudicatario IN (${placeholders}) AND organismo != ?${filterClauseOrg}
           GROUP BY organismo, nif_adjudicatario
           ORDER BY volumen DESC
           LIMIT 50`,
          [...top10adjs, q, ...filterParamsOrg]
        );
      }

      // Pre-build node maps to know which nodes to enrich
      const orgId = `org:${q}`;
      const nodesMap = new Map<string, any>();
      const edgesMap = new Map<string, any>();

      nodesMap.set(orgId, {
        id: orgId,
        name: q,
        type: 'organismo',
        contratos: toNum(adjRows.reduce((s: number, r: any) => s + toNum(r.contratos), 0)),
        volumen: toNum(adjRows.reduce((s: number, r: any) => s + toNum(r.volumen), 0)),
      });

      // Adjudicatario nodes + edges from center
      for (const adj of adjRows) {
        const adjId = adj.nif_adjudicatario || `adj:${adj.adjudicatario}`;
        nodesMap.set(adjId, {
          id: adjId,
          name: adj.adjudicatario,
          type: 'adjudicatario',
          contratos: toNum(adj.contratos),
          volumen: toNum(adj.volumen),
        });
        const eKey = `${orgId}|||${adjId}`;
        if (!edgesMap.has(eKey)) {
          edgesMap.set(eKey, {
            source: orgId,
            target: adjId,
            contratos: toNum(adj.contratos),
            volumen: toNum(adj.volumen),
          });
        }
      }

      // Enrich metrics only for nodes in graph
      const adjNifs = new Set<string>();
      const orgNames = new Set<string>();
      for (const n of nodesMap.values()) {
        if (n.type === 'adjudicatario') adjNifs.add(n.id);
        else if (n.type === 'organismo') orgNames.add(n.name);
      }

      if (adjNifs.size > 0 && orgNames.size > 0) {
        const adjList = Array.from(adjNifs);
        const orgList = Array.from(orgNames);
        const adjPlace = adjList.map(() => '?').join(',');
        const orgPlace = orgList.map(() => '?').join(',');
        const monoRows = await query(`SELECT nif_adjudicatario, organismo,
                  SUM(importe_adjudicacion) as vol_empresa,
                  (SELECT SUM(importe_adjudicacion) FROM contratos_vivos WHERE organismo = t1.organismo${filterClauseOrg}) as vol_total
           FROM contratos_vivos t1
           WHERE nif_adjudicatario IN (${adjPlace}) AND organismo IN (${orgPlace})${filterClauseOrg}
           GROUP BY nif_adjudicatario, organismo`,
          [...adjList, ...orgList, ...filterParamsOrg, ...filterParamsOrg]
        );
        for (const r of monoRows) {
          const adjId = r.nif_adjudicatario;
          const orgId = `org:${r.organismo}`;
          const volEmpresa = toNum(r.vol_empresa);
          const volTotal = toNum(r.vol_total);
          const pct = volTotal > 0 ? (volEmpresa / volTotal) * 100 : 0;
          const adjNode = nodesMap.get(adjId);
          if (adjNode && adjNode.type === 'adjudicatario') {
            if (!adjNode.monopolio_pct || pct > adjNode.monopolio_pct) {
              adjNode.monopolio_pct = Number(pct.toFixed(2));
            }
          }
          const orgNode = nodesMap.get(orgId);
          if (orgNode && orgNode.type === 'organismo') {
            if (!orgNode.dominancia_pct || pct > orgNode.dominancia_pct) {
              orgNode.dominancia_pct = Number(pct.toFixed(2));
            }
          }
        }
      }

      if (adjNifs.size > 0) {
        const adjList = Array.from(adjNifs);
        const adjPlace = adjList.map(() => '?').join(',');
        const concRows = await query(`SELECT nif_adjudicatario,
                  organismo,
                  SUM(importe_adjudicacion) as volumen
           FROM contratos_vivos
           WHERE nif_adjudicatario IN (${adjPlace})${filterClauseOrg}
           GROUP BY nif_adjudicatario, organismo
           ORDER BY nif_adjudicatario, volumen DESC`,
          [...adjList, ...filterParamsOrg]
        );
        const concByAdj = new Map<string, { topVol: number; totalVol: number }>();
        for (const r of concRows) {
          const id = r.nif_adjudicatario;
          const v = toNum(r.volumen);
          let cur = concByAdj.get(id);
          if (!cur) {
            cur = { topVol: v, totalVol: v };
          } else {
            cur.totalVol += v;
          }
          concByAdj.set(id, cur);
        }
        for (const [id, cur] of concByAdj) {
          const node = nodesMap.get(id);
          if (node && node.type === 'adjudicatario') {
            const pct = cur.totalVol > 0 ? (cur.topVol / cur.totalVol) * 100 : 0;
            node.concentracion_pct = Number(pct.toFixed(2));
          }
        }
      }

      // Level 2 organisms
      const l2AdjTotals = new Map<string, { contratos: number; volumen: number }>();
      for (const row of level2Rows) {
        const l2OrgId = `org:${row.organismo}`;
        const adjId = row.nif_adjudicatario || `adj:${row.adjudicatario}`;

        if (!nodesMap.has(l2OrgId)) {
          nodesMap.set(l2OrgId, {
            id: l2OrgId,
            name: row.organismo,
            type: 'organismo',
            contratos: 0,
            volumen: 0,
          });
        }

        const cur = l2AdjTotals.get(l2OrgId) || { contratos: 0, volumen: 0 };
        cur.contratos += toNum(row.contratos);
        cur.volumen += toNum(row.volumen);
        l2AdjTotals.set(l2OrgId, cur);

        const eKey = `${adjId}|||${l2OrgId}`;
        if (!edgesMap.has(eKey) && nodesMap.has(adjId)) {
          edgesMap.set(eKey, {
            source: adjId,
            target: l2OrgId,
            contratos: toNum(row.contratos),
            volumen: toNum(row.volumen),
          });
        }
      }

      // Update L2 node totals
      for (const [l2OrgId, totals] of l2AdjTotals) {
        const node = nodesMap.get(l2OrgId);
        if (node) {
          node.contratos = totals.contratos;
          node.volumen = totals.volumen;
        }
      }

      return new Response(JSON.stringify({
        center: { id: orgId, name: q, type: 'organismo' },
        nodes: Array.from(nodesMap.values()),
        edges: Array.from(edgesMap.values()),
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600',
        },
      });

    } else {
      return new Response(JSON.stringify({ error: 'type debe ser adjudicatario o organismo' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  } catch (err: any) {
    console.error('[graph] Error:', err.message);
    return new Response(JSON.stringify({ error: 'Error al construir el grafo', detail: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
