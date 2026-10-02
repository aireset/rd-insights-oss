import { describe, expect, it } from 'vitest';
import type { SyncRunView } from '@rd/shared';
import { getSyncProgress } from './syncProgress';

const run = (overrides: Partial<SyncRunView> = {}): SyncRunView => ({
  id: 'run-1', kind: 'full', startedAt: '2026-09-28T10:00:00.000Z', finishedAt: null,
  cursor: 0, stats: { lidos: 0, criados: 0, atualizados: 0, erros: 0 }, error: null,
  emAndamento: !overrides.finishedAt,
  ...overrides,
});

describe('getSyncProgress', () => {
  it('maps a missing run to unknown', () => {
    expect(getSyncProgress(null)).toEqual({ kind: 'unknown' });
  });

  it('keeps progress indeterminate when the API has no reliable page total', () => {
    expect(getSyncProgress(run({ cursor: 4, stats: { lidos: 37, criados: 20, atualizados: 17, erros: 0 } }))).toEqual({ kind: 'indeterminate' });
  });

  it('derives and clamps percentage from completed pages and a known total', () => {
    expect(getSyncProgress(run({ cursor: 3, stats: { lidos: 37, criados: 20, atualizados: 17, erros: 0, totalPaginas: 8 } }))).toEqual({ kind: 'determinate', percentage: 38 });
    expect(getSyncProgress(run({ cursor: 9, stats: { lidos: 37, criados: 20, atualizados: 17, erros: 0, totalPaginas: 8 } }))).toEqual({ kind: 'determinate', percentage: 100 });
  });

  it('does not treat zero or invalid totals as measurable progress', () => {
    expect(getSyncProgress(run({ cursor: 3, stats: { lidos: 37, criados: 20, atualizados: 17, erros: 0, totalPaginas: 0 } }))).toEqual({ kind: 'indeterminate' });
  });
});
