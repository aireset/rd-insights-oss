import { describe, expect, it } from 'vitest';
import { leadsQuerySchema } from './leads';

describe('leadsQuerySchema', () => {
  it('aplica defaults e converte tipos vindos da query string', () => {
    const q = leadsQuerySchema.parse({ page: '2', tags: 'a,b', oportunidade: 'true' });
    expect(q).toMatchObject({ page: 2, pageSize: 50, tags: ['a', 'b'], oportunidade: true, sort: 'lastConversionAt', dir: 'desc' });
  });
  it('rejeita pageSize acima de 200', () => {
    expect(() => leadsQuerySchema.parse({ pageSize: '500' })).toThrow();
  });
});
