import { describe, expect, it } from 'vitest';
import { fromSearch, toSearch } from './filtros';

describe('filtros ↔ URL', () => {
  it('ida e volta preserva os campos', () => {
    const f = { q: 'ana', tags: ['vip'], lifecycleStage: ['Lead'], oportunidade: true, page: 2, sort: 'name' as const, dir: 'asc' as const };
    expect(fromSearch(new URLSearchParams(toSearch(f)))).toMatchObject(f);
  });
  it('URL vazia → defaults', () => {
    expect(fromSearch(new URLSearchParams(''))).toMatchObject({ page: 1, sort: 'lastConversionAt', dir: 'desc' });
  });
  it('preserva filtros de segmentos e deduplica IDs recebidos por CSV ou array', () => {
    expect(fromSearch(new URLSearchParams('segmentIds=seg-a%2Cseg-b%2Cseg-a&segmentMatch=all'))).toMatchObject({ segmentIds: ['seg-a', 'seg-b'], segmentMatch: 'all' });
    expect(toSearch({ segmentIds: ['seg-a', 'seg-a'], segmentMatch: 'any' })).toContain('segmentIds=seg-a');
  });
});
