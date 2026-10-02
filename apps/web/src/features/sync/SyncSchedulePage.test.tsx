import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReconciliationScheduleView, SyncRunView } from '@rd/shared';
import { SyncSchedulePage } from './SyncSchedulePage';

const mocks = vi.hoisted(() => ({
  role: 'admin',
  schedule: null as ReconciliationScheduleView | null,
  runs: [] as SyncRunView[],
  scheduleLoading: false,
  runsLoading: false,
  scheduleError: null as unknown,
  runsError: null as unknown,
  coverage: [] as Array<{ id: string; name: string; selected: boolean; available: boolean; coverage: 'unknown' | 'partial' | 'complete'; lastScanAt: string | null; lastDeltaSyncAt: string | null }>,
  coverageLoading: false,
  coverageError: null as unknown,
  reconcile: vi.fn(),
  daily: null as unknown,
}));

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { role: mocks.role } }) }));
vi.mock('./DailySyncPanel', () => ({ DailySyncPanel: () => null }));
vi.mock('./WebhookPanel', () => ({ WebhookPanel: () => null }));
vi.mock('./syncApi', () => ({
  useReconciliationSchedule: () => ({ data: mocks.schedule, isLoading: mocks.scheduleLoading, error: mocks.scheduleError }),
  useReconciliationRuns: () => ({ data: { items: mocks.runs, nextCursor: null }, isFetching: false, isLoading: mocks.runsLoading, error: mocks.runsError }),
  useSegmentCoverage: () => ({ data: mocks.coverage, isLoading: mocks.coverageLoading, error: mocks.coverageError }),
  useDailySync: () => ({ data: mocks.daily, isLoading: false, error: null }),
  useRefreshNow: () => ({ mutate: vi.fn(), isPending: false, error: null, isSuccess: false }),
  useUpdateRefreshBudget: () => ({ mutate: vi.fn(), isPending: false, error: null, isSuccess: false }),
  useReconcileNow: () => ({ mutate: mocks.reconcile, isPending: false, error: null, isSuccess: false }),
}));

const scheduled = (overrides: Partial<ReconciliationScheduleView> = {}): ReconciliationScheduleView => ({
  enabled: true, state: 'scheduled', intervalMinutes: 30,
  nextRunAt: null, lastAttemptAt: null, lastCompletedAt: null, ...overrides,
});

const run = (overrides: Partial<SyncRunView> = {}): SyncRunView => ({
  id: 'run-1', segmentId: 'segment-1', status: 'partial', kind: 'delta',
  startedAt: '2026-09-28T12:00:00.000Z', finishedAt: '2026-09-28T12:03:00.000Z',
  cursor: 2, stats: { lidos: 10, criados: 2, atualizados: 3, erros: 1, totalPaginas: 2 },
  error: 'Timeout no RD', emAndamento: false, ...overrides,
});

function renderPage(): void { render(<MemoryRouter><SyncSchedulePage /></MemoryRouter>); }

describe('SyncSchedulePage', () => {
  beforeEach(() => {
    mocks.role = 'admin'; mocks.schedule = scheduled(); mocks.runs = [];
    mocks.scheduleLoading = false; mocks.runsLoading = false;
    mocks.scheduleError = null; mocks.runsError = null; mocks.reconcile.mockClear();
    mocks.coverage = []; mocks.coverageLoading = false; mocks.coverageError = null;
  });

  it('does not invent a next run or history when timestamps are null', () => {
    renderPage();
    expect(screen.getByText('Sem próxima tentativa')).toBeTruthy();
    expect(screen.getAllByText('Ainda não registrada')).toHaveLength(2);
    expect(screen.queryByText(/2026|2025/)).toBeNull();
  });

  it('shows real schedule timestamps in the account timezone', () => {
    mocks.schedule = scheduled({ nextRunAt: '2026-09-28T12:00:00.000Z', lastAttemptAt: '2026-09-28T10:15:00.000Z', lastCompletedAt: '2026-09-28T10:18:00.000Z' });
    renderPage();
    expect(screen.getByText(/28\/09\/2026, 09:00/)).toBeTruthy();
    expect(screen.getByText(/America\/Sao_Paulo/)).toBeTruthy();
  });

  it('explains paused reconciliation and links to connection setup', () => {
    mocks.schedule = scheduled({ enabled: false, state: 'paused' });
    renderPage();
    expect(screen.getByText('Pausada', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText(/conexão e os segmentos selecionados/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Conectar/ }).getAttribute('href')).toBe('/conectar');
    expect(screen.getByRole('button', { name: /Reconciliar agora/ }).hasAttribute('disabled')).toBe(true);
  });

  it.each([
    ['disabled', 'Desativada'],
    ['unavailable', 'Indisponível'],
  ] as const)('shows the %s schedule state and blocks manual reconciliation', (state, label) => {
    mocks.schedule = scheduled({ enabled: false, state });
    renderPage();
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Reconciliar agora/ }).hasAttribute('disabled')).toBe(true);
    if (state === 'unavailable') {
      expect(screen.getByText(/Serviço de sincronização indisponível/)).toBeTruthy();
      expect(screen.queryByRole('link', { name: /Conectar/ })).toBeNull();
    }
  });
  it('shows partial segment runs, counters, and the error without claiming completion', () => {
    mocks.runs = [run()];
    renderPage();
    expect(screen.getByText('Segmento segment-1')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Parcial');
    expect(screen.getByText(/10 lidos/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Timeout no RD');
    expect(screen.queryByText(/Concluída/, { selector: ':not(option)' })).toBeNull();
  });

  it('shows processed pages when the run has no known page total', () => {
    mocks.runs = [run({ cursor: 4, stats: { lidos: 12, criados: 1, atualizados: 8, erros: 0 } })];
    renderPage();
    expect(screen.getByText('4 páginas processadas')).toBeTruthy();
  });

  it('lets an admin enqueue reconciliation without reporting it completed', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Reconciliar agora/ }));
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Reconciliação concluída/)).toBeNull();
  });

  it('keeps viewers read-only', () => {
    mocks.role = 'viewer';
    renderPage();
    expect(screen.queryByRole('button', { name: /Reconciliar agora/ })).toBeNull();
    expect(screen.getByText(/Somente leitura/)).toBeTruthy();
  });

  it('shows schedule and runs loading and error states', () => {
    mocks.scheduleLoading = true; mocks.runsLoading = true;
    const { rerender } = render(<MemoryRouter><SyncSchedulePage /></MemoryRouter>);
    expect(screen.getAllByText(/Carregando/)).toHaveLength(2);
    mocks.scheduleLoading = false; mocks.runsLoading = false;
    mocks.scheduleError = new Error('Agenda indisponível'); mocks.runsError = new Error('Runs indisponíveis');
    rerender(<MemoryRouter><SyncSchedulePage /></MemoryRouter>);
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent).join(' ')).toContain('Agenda indisponível');
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent).join(' ')).toContain('Runs indisponíveis');
  });

  it('shows segment membership coverage separately from last delta sync, without inventing null dates', () => {
    mocks.coverage = [
      { id: 'seg-a', name: 'Ativos', selected: true, available: true, coverage: 'unknown', lastScanAt: null, lastDeltaSyncAt: null },
      { id: 'seg-b', name: 'Clientes', selected: false, available: false, coverage: 'partial', lastScanAt: '2026-09-28T12:00:00.000Z', lastDeltaSyncAt: '2026-09-28T12:05:00.000Z' },
      { id: 'seg-c', name: 'Leads', selected: true, available: true, coverage: 'complete', lastScanAt: '2026-09-28T12:00:00.000Z', lastDeltaSyncAt: null },
    ];
    renderPage();

    expect(screen.getAllByText('Ativos').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Clientes').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Leads').length).toBeGreaterThan(0);
    expect(screen.getByText('Desconhecida')).toBeTruthy();
    expect(screen.getAllByText('Parcial').length).toBeGreaterThan(0);
    expect(screen.getByText('Completa')).toBeTruthy();
    expect(screen.getAllByText('Não registrada').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/28\/09\/2026, 09:05/)).toBeTruthy();
    expect(screen.getByText(/Não selecionado/)).toBeTruthy();
    expect(screen.getByText(/Não disponível/)).toBeTruthy();
    expect(screen.getByText(/não significa que todos os campos/i)).toBeTruthy();
  });

  it('shows loading and error states for local segment coverage', () => {
    mocks.coverageLoading = true;
    const { rerender } = render(<MemoryRouter><SyncSchedulePage /></MemoryRouter>);
    expect(screen.getByText('Carregando cobertura dos segmentos…')).toBeTruthy();
    mocks.coverageLoading = false;
    mocks.coverageError = new Error('Cobertura indisponível');
    rerender(<MemoryRouter><SyncSchedulePage /></MemoryRouter>);
    expect(screen.getByRole('alert').textContent).toContain('Cobertura indisponível');
  });
});
