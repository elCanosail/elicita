import { describe, expect, it } from 'vitest';
import { explorerRowHtml, filterCompanies, parseExplorerRows, sortCompanies } from '../faro/explorer';

// Filas reales del fixture technology-20260915-153519Z (las tres primeras).
const CSV = [
  'rank,nif,company_name,analytic_contracts,observed_amount_eur,share_amount_pct,share_contracts_pct,group_id,group_name',
  '1,A78053147,"TELEFÓNICA SOLUCIONES DE INFORMÁTICA Y COMUNICACIONES DE ESPAÑA, S.A.U.",1306,1221006415.49,7.339,1.843,,',
  '2,B88018098,"INDRA SOLUCIONES TECNOLOGÍAS DE LA INFORMACIÓN, S.L.U.",999,997349626.10,5.994,1.475,,',
  '3,A28599033,"INDRA SISTEMAS, S.A.",138,524376178.55,3.151,0.208,,',
].join('\n');

describe('parseExplorerRows', () => {
  it('parsea el CSV completo con campos entrecomillados', () => {
    const rows = parseExplorerRows(CSV);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ rank: 1, nif: 'A78053147', contracts: 1306, amountEur: 1221006415.49 });
    expect(rows[0].name).toContain('TELEFÓNICA');
  });
});

describe('filterCompanies', () => {
  const rows = parseExplorerRows(CSV);

  it('cadena vacía devuelve todo', () => {
    expect(filterCompanies(rows, '')).toHaveLength(3);
    expect(filterCompanies(rows, '   ')).toHaveLength(3);
  });

  it('es insensible a acentos y mayúsculas', () => {
    expect(filterCompanies(rows, 'telef')).toHaveLength(1);
    expect(filterCompanies(rows, 'TELEFÓNICA')).toHaveLength(1);
    expect(filterCompanies(rows, 'indra')).toHaveLength(2);
  });

  it('busca por NIF', () => {
    expect(filterCompanies(rows, 'b88018098')).toHaveLength(1);
  });

  it('sin coincidencias devuelve vacío', () => {
    expect(filterCompanies(rows, 'inexistente')).toHaveLength(0);
  });
});

describe('sortCompanies', () => {
  const rows = parseExplorerRows(CSV);

  it('rank restaura el orden editorial', () => {
    expect(sortCompanies([...rows].reverse(), 'rank').map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('importe y cuota descenden', () => {
    expect(sortCompanies(rows, 'amount')[0].rank).toBe(1);
    expect(sortCompanies(rows, 'share')[0].rank).toBe(1);
  });

  it('contratos descenden', () => {
    expect(sortCompanies(rows, 'contracts')[0].contracts).toBe(1306);
  });
});

describe('explorerRowHtml', () => {
  const rows = parseExplorerRows(CSV);
  const maxShare = Math.max(...rows.map((r) => r.shareAmountPct));

  it('reproduce la estructura de renderRankingTable con cifras deterministas', () => {
    const html = explorerRowHtml(rows[0], maxShare);
    expect(html).toContain('class="faro-rank-pos">1</td>');
    expect(html).toContain('Telefónica Soluciones');
    expect(html).toContain('1.221 M€');
    expect(html).toContain('7,34%');
    expect(html).toContain('style="width:100%"');
  });

  it('escapa el nombre y escala la barra a la mayor', () => {
    const html = explorerRowHtml(rows[1], maxShare);
    expect(html).toContain('<div class="faro-rank-name">Indra Soluciones');
    expect(html).toContain('style="width:82%"');
  });
});
