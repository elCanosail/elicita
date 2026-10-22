import { describe, expect, it } from 'vitest';
import {
  CONTACT_TYPES,
  EMAIL_MAX,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_TYPES,
  feedbackFilename,
  isContactType,
  isValidEmail,
  normalizeFeedbackType,
} from '../form-guard';

describe('normalizeFeedbackType (allowlist anti path-traversal)', () => {
  it('acepta los tipos legales', () => {
    for (const t of FEEDBACK_TYPES) expect(normalizeFeedbackType(t)).toBe(t);
  });

  it('normaliza valores desconocidos a "otro"', () => {
    expect(normalizeFeedbackType('../../etc/passwd')).toBe('otro');
    expect(normalizeFeedbackType('bug/../../x')).toBe('otro');
    expect(normalizeFeedbackType(42)).toBe('otro');
    expect(normalizeFeedbackType(undefined)).toBe('otro');
    expect(normalizeFeedbackType('../otro')).toBe('otro');
  });
});

describe('feedbackFilename (el nombre nunca escapa del directorio)', () => {
  it('construye el nombre con el tipo normalizado', () => {
    expect(feedbackFilename('bug', 1700000000000)).toBe('1700000000000-bug.json');
  });

  it('un tipo hostil se normaliza: sin ".." ni separadores en el nombre', () => {
    const name = feedbackFilename(normalizeFeedbackType('../../x'), 1);
    expect(name).toBe('1-otro.json');
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
    expect(name).not.toContain('\\');
  });
});

describe('isContactType', () => {
  it('acepta los valores legales del formulario', () => {
    for (const t of CONTACT_TYPES) expect(isContactType(t)).toBe(true);
  });

  it('rechaza cualquier otro valor', () => {
    expect(isContactType('../../x')).toBe(false);
    expect(isContactType('')).toBe(false);
    expect(isContactType(undefined)).toBe(false);
    expect(isContactType('PERFIL')).toBe(false);
  });
});

describe('isValidEmail', () => {
  it('acepta emails con forma válida', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('  usuario@dominio.es  ')).toBe(true);
  });

  it('rechaza valores inválidos o demasiado largos', () => {
    expect(isValidEmail('sin-arroba')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('a b@c.es')).toBe(false);
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail(undefined)).toBe(false);
    expect(isValidEmail(`${'a'.repeat(EMAIL_MAX)}@x.es`)).toBe(false);
  });
});

describe('topes exportados', () => {
  it('son valores sanos y acotados', () => {
    expect(FEEDBACK_MESSAGE_MAX).toBe(5000);
    expect(EMAIL_MAX).toBe(254);
  });
});
