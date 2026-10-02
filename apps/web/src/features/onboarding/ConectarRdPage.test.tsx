import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConectarRdPage } from './ConectarRdPage';

const mocks = vi.hoisted(() => ({
  syncMutate: vi.fn(),
  connection: undefined as unknown,
  runs: undefined as unknown,
  segments: [] as Array<{ id: string; name: string; available: boolean }>,
  selectionMutate: vi.fn(),
}));

vi.mock('./rdApi', () => ({
  useRdConnection: () => mocks.connection,
  useRdMutations: () => ({
    credentials: { isPending: false, mutate: vi.fn(), error: null },
    authorize: { isPending: false, mutate: vi.fn(), error: null },
    segmentations: { isPending: false, mutate: mocks.selectionMutate, error: null },
    sync: { isPending: false, mutate: mocks.syncMutate, error: null },
    catalog: { isPending: false, mutate: vi.fn(), error: null },
  }),
  useSegmentations: () => ({ data: mocks.segments, error: null }),
  useSyncRuns: () => ({ data: { items: (mocks.runs as { data: unknown[] }).data, nextCursor: null } }),
}));

describe('ConectarRdPage recovery', () => {
  beforeEach(() => {
    mocks.syncMutate.mockClear();
    mocks.selectionMutate.mockClear(); mocks.segments = [];
    mocks.connection = {
      data: {
        status: 'active', hasClientSecret: true, clientId: 'client-id', credencialOrigem: 'painel',
        segmentationId: 'segment-1', segmentationName: 'Todos',
        segmentations: [{ id: 'segment-1', name: 'Todos', standard: true, selected: true, available: true, coverage: 'unknown' }],
        lastFullSyncAt: null, lastError: null,
      },
    };
    mocks.runs = {
      data: [{
        id: 'run-1', kind: 'full', startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        finishedAt: null, cursor: 0, stats: { lidos: 0, criados: 0, atualizados: 0, erros: 0 }, error: null,
        segmentId: 'segment-1', status: 'running',
      }],
    };
  });

  it('busca no catálogo sem perder a seleção que ficou fora da busca', () => {
    mocks.segments = [{ id: 'segment-1', name: 'Todos', available: true }, { id: 'segment-2', name: 'Eventos', available: true }];
    render(<MemoryRouter><ConectarRdPage /></MemoryRouter>);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar segmentações' }), { target: { value: 'eventos' } });
    expect(screen.queryByRole('checkbox', { name: 'Todos' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Eventos' }));
    expect(mocks.selectionMutate).toHaveBeenCalledWith({ segmentationIds: ['segment-1', 'segment-2'] });
  });

  it('mostra o status do run aberto sem inventar percentual', () => {
    render(<MemoryRouter><ConectarRdPage /></MemoryRouter>);

    const button = screen.getByRole('button', { name: 'Iniciar carga' });
    fireEvent.click(button);

    expect(mocks.syncMutate).toHaveBeenCalledOnce();
    expect(screen.getByText(/Em andamento/)).toBeTruthy();
    expect(screen.queryByLabelText(/% das páginas processadas/)).toBeNull();
  });

  it('permite iniciar sincronização com várias segmentações e mostra cada status e erro por segmento', () => {
    mocks.connection = {
      data: {
        ...((mocks.connection as { data: Record<string, unknown> }).data),
        segmentations: [
          { id: 'segment-1', name: 'Leads ativos', standard: false, selected: true, available: true, coverage: 'unknown' },
          { id: 'segment-2', name: 'Leads de eventos', standard: false, selected: true, available: true, coverage: 'unknown' },
        ],
      },
    };
    mocks.runs = {
      data: [
        { id: 'run-1', kind: 'full', startedAt: '2026-09-28T12:00:00.000Z', finishedAt: null, cursor: 0, stats: { lidos: 0, criados: 0, atualizados: 0, erros: 0 }, error: null, segmentId: 'segment-1', status: 'running' },
        { id: 'run-2', kind: 'full', startedAt: '2026-09-28T12:00:00.000Z', finishedAt: '2026-09-28T12:01:00.000Z', cursor: 1, stats: { lidos: 3, criados: 3, atualizados: 0, erros: 1 }, error: 'Timeout do RD', segmentId: 'segment-2', status: 'failed' },
      ],
    };

    render(<MemoryRouter><ConectarRdPage /></MemoryRouter>);

    const button = screen.getByRole('button', { name: 'Iniciar carga' });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(screen.getByText('Leads ativos')).toBeTruthy();
    expect(screen.getByText(/Em andamento/)).toBeTruthy();
    expect(screen.getByText('Leads de eventos')).toBeTruthy();
    expect(screen.getByText(/Falhou: Timeout do RD/)).toBeTruthy();
    expect(screen.queryByLabelText(/% das páginas processadas/)).toBeNull();
    fireEvent.click(button);
    expect(mocks.syncMutate).toHaveBeenCalledOnce();
  });
  it('mostra a última conclusão do segmento, sem atribuir runs legados sem segmento', () => {
    mocks.runs = { data: [
      { id: 'legacy', segmentId: null, kind: 'full', startedAt: '2026-09-29T00:00:00Z', finishedAt: null, cursor: 0, stats: {}, error: 'erro legado' },
      { id: 'done', segmentId: 'segment-1', status: 'completed', kind: 'full', startedAt: '2026-09-28T12:00:00Z', finishedAt: '2026-09-28T12:01:00Z', cursor: 1, stats: {}, error: null },
    ] };
    render(<MemoryRouter><ConectarRdPage /></MemoryRouter>);
    expect(screen.getByText(/Última conclusão:/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Ver leads/ })).toBeTruthy();
    expect(screen.queryByText(/erro legado/)).toBeNull();
  });
});
