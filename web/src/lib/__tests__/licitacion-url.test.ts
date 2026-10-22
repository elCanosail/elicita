import { describe, expect, it } from 'vitest';
import { decodificarParam, urlFichaNormalizada, urlPerfilNormalizada } from '../licitacion-url';

describe('decodificarParam', () => {
  it('identidad en valores RAW URL-safe (fast path — los ya servibles no cambian)', () => {
    expect(decodificarParam('AND:938655')).toBe('AND:938655');
    expect(decodificarParam('EUSKADI')).toBe('EUSKADI');
    expect(decodificarParam('A.123_B~c*d(e)f!g-h')).toBe('A.123_B~c*d(e)f!g-h');
  });

  it('decodifica %3A y %2F (la forma encoded de ids con : y /)', () => {
    expect(decodificarParam('AND%3A938655')).toBe('AND:938655');
    expect(decodificarParam('EUS%3AK-12%2F2020')).toBe('EUS:K-12/2020');
    expect(decodificarParam('MADRID%2F2026%2F001')).toBe('MADRID/2026/001');
  });

  it('decodifica espacios, unicode y %25 (literal % en BD)', () => {
    expect(decodificarParam('EXP%202026')).toBe('EXP 2026');
    expect(decodificarParam('N%C3%BAmero')).toBe('Número');
    expect(decodificarParam('N%C3%9Amero')).toBe('NÚmero');
    expect(decodificarParam('100%25')).toBe('100%');
  });

  it('devuelve null en encoding malformado (% suelto) — no consulta la BD', () => {
    expect(decodificarParam('100%')).toBeNull();
    expect(decodificarParam('EXP%2')).toBeNull();
    expect(decodificarParam('%ZZ')).toBeNull();
  });
});

describe('urlFichaNormalizada', () => {
  it('RAW (identidad) cuando fuente e id son URL-safe', () => {
    expect(urlFichaNormalizada('ANDALUCIA', 'AND:938655')).toBe('/licitacion/ANDALUCIA/AND:938655');
  });

  it('encodeURIComponent cuando el id contiene / (nunca RAW: rompería la ruta)', () => {
    expect(urlFichaNormalizada('EUSKADI', 'EUS:K-12/2020')).toBe(
      '/licitacion/EUSKADI/EUS%3AK-12%2F2020'
    );
  });

  it('encodeURIComponent para espacios, unicode y caracteres fuera del set safe', () => {
    expect(urlFichaNormalizada('PLACSP', 'EXP 2026')).toBe('/licitacion/PLACSP/EXP%202026');
    expect(urlFichaNormalizada('MADRID', 'NÚM/1')).toBe('/licitacion/MADRID/N%C3%9AM%2F1');
    expect(urlFichaNormalizada('FUENTE X', 'ID#1')).toBe('/licitacion/FUENTE%20X/ID%231');
  });

  it('round-trip: la forma normalizada decodificada reproduce el valor de BD', () => {
    const casos: Array<[string, string]> = [
      ['ANDALUCIA', 'AND:938655'],
      ['EUSKADI', 'EUS:K-12/2020'],
      ['PLACSP', 'EXP 2026'],
      ['MADRID', 'NÚM/1'],
    ];
    for (const [f, id] of casos) {
      const url = urlFichaNormalizada(f, id);
      const partes = url.split('/').filter(Boolean); // ['licitacion', fuente, id]
      expect(partes.length).toBe(3);
      expect(decodificarParam(partes[1])).toBe(f);
      expect(decodificarParam(partes[2])).toBe(id);
    }
  });

  it('coincidencia con la política del sitemap: el set safe emite RAW exacto', () => {
    // El generador web/scripts/sitemap-licitaciones.mjs usa SAFE_ID/SAFE_FUENTE
    // con la misma definición: para ids safe la URL emitida es la RAW.
    const SAFE_ID = /^[A-Za-z0-9._!~*'():-]+$/;
    const SAFE_FUENTE = /^[A-Za-z0-9._!~*'()-]+$/;
    const casos: Array<[string, string]> = [
      ['ANDALUCIA', 'AND:938655'],
      ['EUSKADI', 'EUS:K-12/2020'],
      ['PLACSP', 'EXP 2026'],
    ];
    for (const [f, id] of casos) {
      const raw = `/licitacion/${f}/${id}`;
      const url = urlFichaNormalizada(f, id);
      if (SAFE_FUENTE.test(f) && SAFE_ID.test(id)) {
        expect(url).toBe(raw);
      } else {
        expect(url).not.toBe(raw);
        expect(url).toBe(`/licitacion/${encodeURIComponent(f)}/${encodeURIComponent(id)}`);
      }
    }
  });
});

describe('urlPerfilNormalizada (tarea 42)', () => {
  it('RAW (identidad) para NIFs URL-safe — sin churn en las URLs ya enlazadas', () => {
    expect(urlPerfilNormalizada('B12345678')).toBe('/perfil/B12345678');
    expect(urlPerfilNormalizada('A46995343')).toBe('/perfil/A46995343');
    expect(urlPerfilNormalizada('b12345678')).toBe('/perfil/b12345678');
  });

  it('encodeURIComponent para NIFs con espacio, barra o unicode', () => {
    expect(urlPerfilNormalizada('A 97050165')).toBe('/perfil/A%2097050165');
    expect(urlPerfilNormalizada('1241708/D/M/000')).toBe('/perfil/1241708%2FD%2FM%2F000');
    expect(urlPerfilNormalizada('NÚM')).toBe('/perfil/N%C3%9AM');
  });

  it('round-trip: la forma normalizada decodificada reproduce el NIF de BD', () => {
    const casos = ['B12345678', 'A 97050165', '1241708/D/M/000', 'NÚM'];
    for (const nif of casos) {
      const url = urlPerfilNormalizada(nif);
      const partes = url.split('/').filter(Boolean); // ['perfil', nif]
      expect(partes.length).toBe(2);
      expect(decodificarParam(partes[1])).toBe(nif);
    }
  });

  it('coincidencia con la política del sitemap de perfiles (SAFE_NIF espejo)', () => {
    const SAFE_NIF = /^[A-Za-z0-9._!~*'():-]+$/;
    const casos = ['B12345678', 'A 97050165', '1241708/D/M/000'];
    for (const nif of casos) {
      const url = urlPerfilNormalizada(nif);
      if (SAFE_NIF.test(nif)) {
        expect(url).toBe(`/perfil/${nif}`);
      } else {
        expect(url).toBe(`/perfil/${encodeURIComponent(nif)}`);
      }
    }
  });
});
