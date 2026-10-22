/**
 * Tests de correcciones.ts — espejo local de calidad/correcciones.py upstream
 * (BquantFinance/licitaciones-espana, issue #22).
 *
 * Procedencia de los datos:
 *  - Verificados ad-hoc contra plataformas de origen el 28-09-2026 (comentario
 *    en issue #22): URDINBERRI (confirmado upstream en errores_fuente.csv),
 *    EGURKI expjaso14126 (Euskadi: adj 46.984.173 € / presupuesto 469.841,73 €,
 *    "mismas cifras exactas"), C-337C/004-22 (portal Comunidad de Madrid:
 *    36.650.000,00 €).
 *  - Filas reales del dataset elicita (contratos_historico, lectura read-only):
 *    URDINBERRI expediente 01/2024 (url de origen expjaso522774, adj 2.357.531.666 €,
 *    presupuesto 25.188.819,27 €), KNORR BREMSE ESPAÑA (Madrid PCON, adj 3.999.728 € /
 *    pres 3.999,28 €), HIPODROMOS Y APUESTAS HÍPICAS EUSKADI (expjaso360058, adj
 *    45.000 € / pres 1 €), ENDESA X Servicios (gencat, adj 15.480 € / pres 4 €),
 *    UTE URDINBERRI - VIUDA DE SAINZ (expjaso396588, adj 8.498.440,65 € /
 *    pres 9.329.676,30 €).
 *  - C-337C: el valor corregido (36.650.000,00 €) está verificado en origen; el
 *    par del test (adj 3.665.000.000 / pres 36.650.000) es reconstrucción mínima
 *    consistente (la fila local C-337C/005-22 viene sin adjudicación).
 *  - Semántica validada contra el correcciones.py upstream (calidad/, commit
 *    main 2026-09-28): el salto de entrada es adj >= lic * SALTO_ESCALA (100×)
 *    y la banda [0,5, 1,05] opera después, como en el espejo local.
 */

import { describe, expect, it } from 'vitest';
import { corregirImporteAdjudicacion } from '../correcciones';

const URL_URDINBERRI_ORIGEN =
  'https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/contenidos/anuncio_contratacion/expjaso522774/es_doc/index.html';
const URL_URDINBERRI_PLACSP =
  'https://contrataciondelestado.es/sindicacion/PlataformasAgregadasSinMenores/15091104';
const URL_EGURKI =
  'https://apps.euskadi.eus/w32-1084/es/contenidos/anuncio_contratacion/expjaso14126/es_doc/es_arch_expjaso14126.html';

describe('corregirImporteAdjudicacion — registro (errores verificados en fuente)', () => {
  const filaReal = {
    importeAdjudicacion: 2_357_531_666,
    presupuesto: 25_188_819.27,
    urlPub: URL_URDINBERRI_ORIGEN,
  };

  it('aplica la corrección verificada a la fila real del dataset (url de origen Euskadi)', () => {
    expect(corregirImporteAdjudicacion(filaReal)).toEqual({
      valor: 2_357_531.666,
      motivo: 'registro',
    });
  });

  it('casa también la url de sindicación PLACSP (id completo en errores_fuente.csv upstream)', () => {
    expect(corregirImporteAdjudicacion({ ...filaReal, urlPub: URL_URDINBERRI_PLACSP })).toEqual({
      valor: 2_357_531.666,
      motivo: 'registro',
    });
  });

  it('el registro manda sobre la escala: con el presupuesto verificado del expediente (2.518.819,27 €) el heurístico daría escala_x1000', () => {
    // Salto 936× y el escalado x1000 (q ≈ 0,936) cae en banda; el registro
    // verificado tiene prioridad, como en correcciones.py.
    expect(
      corregirImporteAdjudicacion({
        importeAdjudicacion: 2_357_531_666,
        presupuesto: 2_518_819.27,
        urlPub: URL_URDINBERRI_ORIGEN,
      }),
    ).toEqual({ valor: 2_357_531.666, motivo: 'registro' });
  });

  it('no toca una versión que ya publica el valor corregido en la fuente', () => {
    expect(
      corregirImporteAdjudicacion({ ...filaReal, importeAdjudicacion: 2_357_531.67 }),
    ).toEqual({ valor: 2_357_531.67, motivo: null });
  });

  it('no casa otro anuncio distinto con el mismo importe inflado', () => {
    expect(
      corregirImporteAdjudicacion({
        ...filaReal,
        urlPub:
          'https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/contenidos/anuncio_contratacion/expjaso999999/es_doc/index.html',
      }),
    ).toEqual({ valor: 2_357_531_666, motivo: null });
  });
});

describe('corregirImporteAdjudicacion — escala_x100/x1000', () => {
  it('EGURKI expjaso14126 (real): mismas cifras exactas tras /100', () => {
    expect(
      corregirImporteAdjudicacion({
        importeAdjudicacion: 46_984_173,
        presupuesto: 469_841.73,
        urlPub: URL_EGURKI,
      }),
    ).toEqual({ valor: 469_841.73, motivo: 'escala_x100' });
  });

  it('C-337C/004-22 Comunidad de Madrid (reconstruido): /100 devuelve el valor verificado en origen', () => {
    expect(
      corregirImporteAdjudicacion({ importeAdjudicacion: 3_665_000_000, presupuesto: 36_650_000 }),
    ).toEqual({ valor: 36_650_000, motivo: 'escala_x100' });
  });

  it('presupuesto redondeado: el exacto falla pero la banda lo salva', () => {
    // EGURKI con un presupuesto publicado que no reproduce las cifras exactas
    // (465.000 €): salto 101,04× (≥100×); el exacto falla (|escalado − pres|
    // = 4.841,73 € > 0,005) y la banda lo salva (escalado/pres ≈ 1,0104 ∈
    // [0,5, 1,05], pres ≥ 10.000 €).
    expect(
      corregirImporteAdjudicacion({ importeAdjudicacion: 46_984_173, presupuesto: 465_000 }),
    ).toEqual({ valor: 469_841.73, motivo: 'escala_x100' });
  });

  it('un salto de 99,97× no llega al umbral de 100×: sin corrección (límite del heurístico, idéntico a upstream)', () => {
    // EGURKI con el presupuesto publicado redondeado a 470.000 €:
    // 46.984.173 < 100 × 470.000 → no hay salto que corregir. Fija el borde de
    // detección de salto_escala upstream (adj >= lic * SALTO_ESCALA).
    expect(
      corregirImporteAdjudicacion({ importeAdjudicacion: 46_984_173, presupuesto: 470_000 }),
    ).toEqual({ valor: 46_984_173, motivo: null });
  });

  it('coma perdida ×1000: la banda aplica y devuelve escala_x1000', () => {
    expect(
      corregirImporteAdjudicacion({ importeAdjudicacion: 1_020_000_000, presupuesto: 1_000_000 }),
    ).toEqual({ valor: 1_020_000, motivo: 'escala_x1000' });
  });
});

describe('corregirImporteAdjudicacion — inverosimil y no_comparable', () => {
  it('KNORR BREMSE (real): el x1000 vuelve al orden pero el presupuesto < 10.000 € no da banda fiable', () => {
    // adj 3.999.728 / pres 3.999,28: x1000 → 3.999,728 (q ≈ 1,0001) pero pres
    // < 10.000 → sin banda; x100 queda 10× fuera; exacto no cuadra (0,448 €).
    expect(
      corregirImporteAdjudicacion({
        importeAdjudicacion: 3_999_728,
        presupuesto: 3_999.28,
        urlPub:
          'http://www.madrid.org/cs/Satellite?op2=PCON&idPagina=1204201624785&c=CM_ConvocaPrestac_FA&pagename=PortalContratacion%2FPage%2FPCON_contratosPublicos&language=es&idConsejeria=1109266187224&cid=1354669590415',
      }),
    ).toEqual({ valor: null, motivo: 'inverosimil' });
  });

  it('presupuesto < 1.000 € con salto: no_comparable mantiene la adjudicación (HIPODROMOS, real)', () => {
    expect(
      corregirImporteAdjudicacion({
        importeAdjudicacion: 45_000,
        presupuesto: 1,
        urlPub:
          'https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/contenidos/anuncio_contratacion/expjaso360058/es_doc/index.html',
      }),
    ).toEqual({ valor: 45_000, motivo: 'no_comparable' });
  });

  it('no_comparable con presupuesto simbólico (ENDESA X, gencat, real)', () => {
    expect(
      corregirImporteAdjudicacion({
        importeAdjudicacion: 15_480,
        presupuesto: 4,
        urlPub:
          'https://contractaciopublica.gencat.cat/ecofin_pscp/AppJava/awardnotice.pscp?reqCode=viewPcan&idDoc=117080279&lawType=3',
      }),
    ).toEqual({ valor: 15_480, motivo: 'no_comparable' });
  });
});

describe('corregirImporteAdjudicacion — sin salto y sin adjudicación', () => {
  it('sin salto ≥100× devuelve el importe publicado tal cual (UTE URDINBERRI, real)', () => {
    expect(
      corregirImporteAdjudicacion({
        importeAdjudicacion: 8_498_440.65,
        presupuesto: 9_329_676.3,
        urlPub:
          'https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/contenidos/anuncio_contratacion/expjaso396588/es_doc/index.html',
      }),
    ).toEqual({ valor: 8_498_440.65, motivo: null });
  });

  it('sin adjudicación no hay nada que corregir', () => {
    expect(corregirImporteAdjudicacion({ importeAdjudicacion: null, presupuesto: 1_000 })).toEqual({
      valor: null,
      motivo: null,
    });
  });

  it('adjudicación 0, negativa o no finita tampoco corrige', () => {
    expect(corregirImporteAdjudicacion({ importeAdjudicacion: 0, presupuesto: 1_000 })).toEqual({
      valor: null,
      motivo: null,
    });
    expect(corregirImporteAdjudicacion({ importeAdjudicacion: -5, presupuesto: 1_000 })).toEqual({
      valor: null,
      motivo: null,
    });
    expect(
      corregirImporteAdjudicacion({ importeAdjudicacion: Number.NaN, presupuesto: 1_000 }),
    ).toEqual({ valor: null, motivo: null });
  });

  it('sin presupuesto no hay salto que medir: importe intacto', () => {
    expect(
      corregirImporteAdjudicacion({ importeAdjudicacion: 2_357_531_666, presupuesto: null }),
    ).toEqual({ valor: 2_357_531_666, motivo: null });
  });
});

describe('corregirImporteAdjudicacion — bordes de la regla de escala', () => {
  it('tolerancia atol 0,005 €: 0,004 € de diferencia entra como exacto', () => {
    expect(
      corregirImporteAdjudicacion({ importeAdjudicacion: 100_000.4, presupuesto: 1_000 }),
    ).toEqual({ valor: 1_000, motivo: 'escala_x100' });
  });

  it('fuera de tolerancia (0,01 €) y sin banda (pres < 10.000 €): inverosimil', () => {
    expect(
      corregirImporteAdjudicacion({ importeAdjudicacion: 100_001, presupuesto: 1_000 }),
    ).toEqual({ valor: null, motivo: 'inverosimil' });
  });

  it('banda con presupuesto = 10.000 € exacto: borde inferior q = 0,5 incluido (vía x1000)', () => {
    // Salto 500× (≥100×); x100 da q = 5 (fuera de banda) y x1000 deja el
    // escalado en 5.000 € con q = 0,5 exactamente en el borde inferior de
    // [0,5, 1,05], con pres = 10.000 € (umbral incluido).
    expect(
      corregirImporteAdjudicacion({ importeAdjudicacion: 5_000_000, presupuesto: 10_000 }),
    ).toEqual({ valor: 5_000, motivo: 'escala_x1000' });
  });

  it('banda incluye q = 1,05 (borde superior)', () => {
    expect(
      corregirImporteAdjudicacion({ importeAdjudicacion: 1_050_000, presupuesto: 10_000 }),
    ).toEqual({ valor: 10_500, motivo: 'escala_x100' });
  });

  it('banda excluye q = 1,06', () => {
    expect(
      corregirImporteAdjudicacion({ importeAdjudicacion: 1_060_000, presupuesto: 10_000 }),
    ).toEqual({ valor: null, motivo: 'inverosimil' });
  });

  it('la banda exige presupuesto ≥ 10.000 € (9.999 no cualifica)', () => {
    // Salto 100,01× (≥100×): el exacto falla (|10.000 − 9.999| = 1 €), la banda
    // por ratio cumpliría (q ≈ 1,0001) pero pres < 10.000 € la bloquea, y x1000
    // (q ≈ 0,1) no alcanza la banda → inverosimil.
    expect(
      corregirImporteAdjudicacion({ importeAdjudicacion: 1_000_000, presupuesto: 9_999 }),
    ).toEqual({ valor: null, motivo: 'inverosimil' });
  });
});
