import type { SyncRunView } from '@rd/shared';

export type SyncProgress =
  | { kind: 'unknown' }
  | { kind: 'indeterminate' }
  | { kind: 'determinate'; percentage: number };

export function getSyncProgress(run: SyncRunView | null | undefined): SyncProgress {
  if (!run) return { kind: 'unknown' };

  const total = run.stats?.totalPaginas;
  if (!Number.isFinite(total) || total === undefined || total <= 0) return { kind: 'indeterminate' };

  const cursor = Number.isFinite(run.cursor) ? Math.max(0, run.cursor) : 0;
  const percentage = Math.min(100, Math.max(0, Math.round((cursor / total) * 100)));
  return { kind: 'determinate', percentage };
}
