import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DailySyncView } from '@rd/shared';
import { DailySyncPanel } from './DailySyncPanel';

const mocks = vi.hoisted(() => ({
  role: 'admin', data: null as DailySyncView | null, loading: false, error: null as unknown,
  refresh: vi.fn(), budget: vi.fn(), refreshPending: false, budgetPending: false,
  refreshError: null as unknown, budgetError: null as unknown, refreshSuccess: false, budgetSuccess: false,
}));

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { role: mocks.role } }) }));
vi.mock('./syncApi', () => ({
  useDailySync: () => ({ data: mocks.data, isLoading: mocks.loading, error: mocks.error }),
  useRefreshNow: () => ({ mutate: mocks.refresh, isPending: mocks.refreshPending, error: mocks.refreshError, isSuccess: mocks.refreshSuccess }),
  useUpdateRefreshBudget: () => ({ mutate: mocks.budget, isPending: mocks.budgetPending, error: mocks.budgetError, isSuccess: mocks.budgetSuccess }),
}));

const view = (state: 'scheduled' | 'paused' | 'unavailable' = 'scheduled', used = 40): DailySyncView => ({
  enabled: true,
  refresh: { state, nextRunAt: '2026-09-28T12:00:00.000Z', lastCompletedAt: '2026-09-27T12:00:00.000Z', budget: { limit: 100, used, resetsAt: '2026-09-29T00:00:00.000Z' }, run: { status: 'running', startedAt: '2026-09-28T11:00:00.000Z', leadsCompleted: 17, step: 'conversions', page: 3, error: null } },
  catalog: { state: 'scheduled', nextRunAt: '2026-09-28T13:00:00.000Z', lastAttemptAt: '2026-09-28T10:00:00.000Z', lastCompletedAt: null, error: 'Falha anterior', budget: { limit: 50, used: 4 } },
});

describe('DailySyncPanel', () => {
  beforeEach(() => { Object.assign(mocks, { role: 'admin', data: view(), loading: false, error: null, refreshPending: false, budgetPending: false, refreshError: null, budgetError: null, refreshSuccess: false, budgetSuccess: false }); mocks.refresh.mockClear(); mocks.budget.mockClear(); });

  it('shows daily state, real timestamps in Sao Paulo, run checkpoint and separate catalog health', () => {
    render(<DailySyncPanel />);
    expect(screen.getByText('28/09/2026, 09:00')).toBeTruthy();
    expect(screen.getByText('27/09/2026, 09:00')).toBeTruthy();
    expect(screen.getByText(/17 leads processados/)).toBeTruthy();
    expect(screen.getByText(/Conversões · página 3/)).toBeTruthy();
    expect(screen.getByText('Catálogo de segmentações')).toBeTruthy();
    expect(screen.getByText('40 de 100 chamadas')).toBeTruthy();
    expect(screen.getByText('28/09/2026, 21:00')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Falha anterior');
    expect(screen.getByText(/base grande pode levar várias execuções diárias/)).toBeTruthy();
  });

  it('shows loading and errors', () => {
    mocks.loading = true; const { rerender } = render(<DailySyncPanel />);
    expect(screen.getByText(/Carregando sincronização diária/)).toBeTruthy();
    mocks.loading = false; mocks.error = new Error('Falhou'); rerender(<DailySyncPanel />);
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent).join(' ')).toContain('Falhou');
  });

  it('blocks a refresh when the daily budget is exhausted', () => {
    mocks.data = view('scheduled', 100); render(<DailySyncPanel />);
    expect(screen.getByRole('button', { name: /Solicitar refresh/ }).hasAttribute('disabled')).toBe(true);
  });

  it.each(['paused', 'unavailable'] as const)('disables controls when refresh is %s', (state) => {
    mocks.data = view(state); render(<DailySyncPanel />);
    expect(screen.getByRole('button', { name: /Solicitar refresh/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /Salvar orçamento/ }).hasAttribute('disabled')).toBe(true);
  });

  it('keeps viewers read-only', () => {
    mocks.role = 'viewer'; render(<DailySyncPanel />);
    expect(screen.queryByRole('button', { name: /Solicitar refresh/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Salvar orçamento/ })).toBeNull();
    expect(screen.getByText(/Somente leitura/)).toBeTruthy();
  });

  it('lets admins request refresh and set the account daily budget', () => {
    render(<DailySyncPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Solicitar refresh/ }));
    fireEvent.change(screen.getByLabelText(/Limite diário/), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar orçamento/ }));
    expect(mocks.refresh).toHaveBeenCalledOnce(); expect(mocks.budget).toHaveBeenCalledWith(250);
  });

  it('says queued, not complete, after requesting a refresh', () => {
    mocks.refreshSuccess = true; render(<DailySyncPanel />);
    expect(screen.getByText(/enfileirado; ainda não foi concluído/)).toBeTruthy();
  });
});
