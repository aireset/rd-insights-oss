import { describe, expect, it } from 'vitest';
import { dataHora } from './format';

describe('dataHora', () => {
  it('formata dd/mm/aaaa hh:mm', () => {
    expect(dataHora(new Date(2026, 8, 5, 7, 3).toISOString())).toBe('05/09/2026 07:03');
  });
  it('vazio ou inválido vira travessão', () => {
    expect(dataHora(null)).toBe('—');
    expect(dataHora('lixo')).toBe('—');
  });
});
