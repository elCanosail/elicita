import { describe, it, expect } from 'vitest';
import {
  normalizeBormeName,
  bormeMatchKey,
  bormePdfUrl,
  parseBormeFecha,
  buildBormeTimeline,
  type BormeEmpRow,
  type BormeCargoRow,
} from '../borme';

describe('normalizeBormeName (regla upstream empresa_norm)', () => {
  it('recorta sufijos societarios finales', () => {
    expect(normalizeBormeName('INDRA SISTEMAS SA')).toBe('INDRA SISTEMAS');
    expect(normalizeBormeName('JAGUSETAS SOCIEDAD LIMITADA')).toBe('JAGUSETAS');
    expect(normalizeBormeName('MILQUERH SL')).toBe('MILQUERH');
    expect(normalizeBormeName('MUNDIWEB TELECOM SL')).toBe('MUNDIWEB TELECOM');
  });

  it('conserva acentos, comas y puntos como upstream', () => {
    expect(normalizeBormeName('IBERICA DE DISTRIBUCION Y OPERADORES EXTREMEÑOS SL'))
      .toBe('IBERICA DE DISTRIBUCION Y OPERADORES EXTREMEÑOS');
    expect(normalizeBormeName('ALONSO CONSTRUCCION, MANTENIMIENTO Y MEDIO AMBIENTE SL'))
      .toBe('ALONSO CONSTRUCCION, MANTENIMIENTO Y MEDIO AMBIENTE');
  });

  it('no recorta cuando trae anotación de unipersonalidad (regla upstream)', () => {
    expect(normalizeBormeName('SERVICIOS TRIBUTARIOS ADMINISTRACION LOCAL SL. Sociedad unipersonal'))
      .toBe('SERVICIOS TRIBUTARIOS ADMINISTRACION LOCAL SL. SOCIEDAD UNIPERSONAL');
  });

  it('sufijos con puntuación se recortan igual (S.L., S.A.)', () => {
    expect(normalizeBormeName('FAES FARMA, S.A.')).toBe('FAES FARMA');
    expect(normalizeBormeName('SUN PHARMA LABORATORIOS, S.L.U.')).toBe('SUN PHARMA LABORATORIOS');
  });

  it('no recorta el único token ni degrada nombres vacíos', () => {
    expect(normalizeBormeName('SA')).toBe('SA');
    expect(normalizeBormeName('')).toBe('');
  });
});

describe('bormeMatchKey (igualdad exacta, no LIKE)', () => {
  it('ignora puntuación y espacios para comparar NIF↔BORME', () => {
    expect(bormeMatchKey('FAES FARMA, S.A.')).toBe(bormeMatchKey('FAES FARMA SA'));
    expect(bormeMatchKey('OCTAPHARMA,S.A.')).toBe(bormeMatchKey('OCTAPHARMA'));
    expect(bormeMatchKey('MILQUERH')).toBe(bormeMatchKey('MILQUERH SL.'));
  });

  it('distingue empresas distintas aunque compartan prefijo', () => {
    expect(bormeMatchKey('INDRA SISTEMAS')).not.toBe(bormeMatchKey('INDRA'));
  });
});

describe('bormePdfUrl', () => {
  it('construye la URL oficial de boe.es desde filename + fecha', () => {
    expect(bormePdfUrl('BORME-A-2009-21-28.pdf', '2009-02-02'))
      .toBe('https://www.boe.es/borme/dias/2009/02/02/pdfs/BORME-A-2009-21-28.pdf');
  });

  it('null sin filename, sin fecha o con filename no-BORME', () => {
    expect(bormePdfUrl(null, '2026-02-18')).toBeNull();
    expect(bormePdfUrl('BORME-A-2026-10-28.pdf', null)).toBeNull();
    expect(bormePdfUrl('otro.pdf', '2026-02-18')).toBeNull();
  });
});

describe('parseBormeFecha', () => {
  it('soporta Date, ISO y el formato upstream DD.MM.YY con/sin punto', () => {
    expect(parseBormeFecha(new Date(Date.UTC(2026, 0, 2)))).toBe('2026-01-02');
    expect(parseBormeFecha('2026-02-18 00:00:00')).toBe('2026-02-18');
    expect(parseBormeFecha('22.01.26.')).toBe('2026-01-22');
    expect(parseBormeFecha('27.10.99')).toBe('1999-10-27');
    expect(parseBormeFecha(null)).toBeNull();
  });
});

describe('buildBormeTimeline (join + agrupación)', () => {
  const emp: BormeEmpRow[] = [
    {
      fecha_borme: '2026-10-05', num_entrada: '83737', empresa: 'EMPRESA DEMO SL',
      empresa_norm: 'EMPRESA DEMO', provincia: 'MADRID',
      actos: 'Nombramientos|Modificaciones estatutarias', domicilio: 'C/ NUEVA 1',
      capital_euros: 12000, fecha_constitucion: '10.03.20.', hoja_registral: 'M 700000',
      tomo: '46000', inscripcion: '10', fecha_inscripcion: '05.10.26',
      pdf_filename: 'BORME-A-2026-190-28.pdf',
    },
    {
      fecha_borme: '2015-05-12', num_entrada: '1000', empresa: 'EMPRESA DEMO SL',
      empresa_norm: 'EMPRESA DEMO', provincia: 'MADRID', actos: 'Constitución|Nombramientos',
      domicilio: 'C/ VIEJA 2', capital_euros: 3000, fecha_constitucion: '10.03.20.',
      hoja_registral: 'M 700000', tomo: '34000', inscripcion: '1',
      fecha_inscripcion: '12.05.15', pdf_filename: 'BORME-A-2015-88-28.pdf',
    },
  ];
  const car: BormeCargoRow[] = [
    {
      fecha_borme: '2026-10-05', num_entrada: '83737', empresa_norm: 'EMPRESA DEMO',
      tipo_acto: 'nombramiento', cargo: 'Consejero', persona_hash: 'abc123',
      pdf_filename: 'BORME-A-2026-190-28.pdf',
    },
    {
      fecha_borme: '2015-05-12', num_entrada: '1000', empresa_norm: 'EMPRESA DEMO',
      tipo_acto: 'nombramiento', cargo: 'Administrador único', persona_hash: 'def456',
      pdf_filename: 'BORME-A-2015-88-28.pdf',
    },
  ];

  it('agrupa por fecha desc y consume las cabeceras ya representadas por cargos', () => {
    const t = buildBormeTimeline(emp, car, new Map([['abc123', 'ANA LOPEZ']]));
    expect(t).not.toBeNull();
    expect(t!.totalDias).toBe(2);
    expect(t!.dias[0].fecha).toBe('2026-10-05');
    // Nombramientos de 2026 sale como cargo con persona, NO repetido en otros
    expect(t!.dias[0].cargos).toEqual([
      { tipo: 'Nombramientos', cargo: 'Consejero', persona: 'ANA LOPEZ', personaHash: 'abc123' },
    ]);
    expect(t!.dias[0].otros).toEqual(['Modificaciones estatutarias']);
    expect(t!.dias[0].pdfUrl).toBe('https://www.boe.es/borme/dias/2026/10/05/pdfs/BORME-A-2026-190-28.pdf');
    // 2015: cabecera Constitución queda como «otros» (sin cargos asociados)
    expect(t!.dias[1].otros).toContain('Constitución');
  });

  it('persona desconocida (hash histórico opaco) sale null, sin hash expuesto', () => {
    const t = buildBormeTimeline(emp, car, new Map());
    expect(t!.dias[0].cargos[0].persona).toBeNull();
    expect(t!.dias[0].cargos[0].personaHash).toBe('abc123');
  });

  it('ficha: último no nulo por fecha desc para cada campo', () => {
    const t = buildBormeTimeline(emp, car)!;
    expect(t.ficha.domicilio).toBe('C/ NUEVA 1');
    expect(t.ficha.capital_euros).toBe(12000);
    expect(t.ficha.ultima_inscripcion).toBe('2026-10-05');
  });

  it('trunca a maxDias conservando totalDias', () => {
    const t = buildBormeTimeline(emp, car, new Map(), { maxDias: 1 })!;
    expect(t.dias).toHaveLength(1);
    expect(t.totalDias).toBe(2);
  });

  it('null sin filas (perfil sin match → sección ausente)', () => {
    expect(buildBormeTimeline([], [], new Map())).toBeNull();
  });
});
