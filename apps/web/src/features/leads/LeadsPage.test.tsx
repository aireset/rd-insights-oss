import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeadRow, Page } from '@rd/shared';
import { LeadsPage } from './LeadsPage';

const mocks = vi.hoisted(() => ({
  adminCatalog: vi.fn(() => ({ data: [] })),
  leadError: undefined as unknown,
  leadData: { items: [], total: 0, page: 1, pageSize: 50 } as Page<LeadRow>,
  facetQuery: undefined as unknown,
  exportLeads: vi.fn(async () => undefined),
  savedViews: [{ id: 'view-1', name: 'Quentes em Londrina', filters: { cidade: 'Londrina', aiScore: 'quente', segmentIds: ['seg-a'], segmentMatch: 'any' }, createdAt: '', updatedAt: '' }],
  saveMutate: vi.fn((_input: unknown, options?: { onSuccess?: (view: { id: string }) => void }) => options?.onSuccess?.({ id: 'new-view' })),
  deleteMutate: vi.fn(),
  connection: {
    status: 'active', hasClientSecret: true, clientId: 'client', credencialOrigem: 'painel',
    segmentationId: 'seg-a', segmentationName: 'Ativos', lastFullSyncAt: null, lastError: null,
    segmentations: [
      { id: 'seg-a', name: 'Ativos', standard: false, selected: true, available: true, coverage: 'complete' },
      { id: 'seg-b', name: 'Eventos', standard: false, selected: true, available: true, coverage: 'complete' },
      { id: 'seg-paused', name: 'Pausada', standard: false, selected: false, available: true, coverage: 'unknown' },
      { id: 'seg-gone', name: 'Indisponível', standard: false, selected: true, available: false, coverage: 'unknown' },
    ],
  },
}));

vi.mock('./leadsApi', () => ({
  exportLeads: mocks.exportLeads,
  useLeads: () => ({ data: mocks.leadData, isFetching: false, error: mocks.leadError }),
  useFacets: (q: unknown) => { mocks.facetQuery = q; return { data: { lifecycleStages: [], tags: [], conversoes: [] } }; },
  useSavedViews: () => ({ data: mocks.savedViews }),
  useSaveView: () => ({ mutate: mocks.saveMutate, isPending: false, isError: false }),
  useDeleteSavedView: () => ({ mutate: mocks.deleteMutate, isPending: false, isError: false }),
}));
vi.mock('../onboarding/rdApi', () => ({ useRdConnection: () => ({ data: mocks.connection }), useSegmentations: mocks.adminCatalog }));

function CurrentSearch(): React.ReactElement {
  const { search } = useLocation();
  return <output aria-label="URL atual">{search}</output>;
}

describe('LeadsPage segment filters', () => {
  beforeEach(() => { mocks.adminCatalog.mockClear(); mocks.exportLeads.mockClear(); mocks.saveMutate.mockClear(); mocks.deleteMutate.mockClear(); mocks.leadError = undefined; mocks.facetQuery = undefined; mocks.leadData = { items: [], total: 0, page: 1, pageSize: 50 }; });

  it('exposes active segments and persists selected IDs and any/all in the URL', () => {
    render(<MemoryRouter initialEntries={['/leads']}><Routes><Route path="/leads" element={<><LeadsPage /><CurrentSearch /></>} /></Routes></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Filtros/ }));

    expect(screen.getByLabelText('Ativos')).toBeTruthy();
    expect(screen.getByLabelText('Eventos')).toBeTruthy();
    expect(screen.queryByLabelText('Pausada')).toBeNull();
    expect(screen.queryByLabelText('Indisponível')).toBeNull();
    expect(mocks.adminCatalog).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Ativos'));
    fireEvent.click(screen.getByLabelText('Eventos'));
    fireEvent.change(screen.getByLabelText('Correspondência de segmentos'), { target: { value: 'all' } });

    expect(screen.getByLabelText('URL atual').textContent).toContain('segmentIds=seg-a%2Cseg-b');
    expect(screen.getByLabelText('URL atual').textContent).toContain('segmentMatch=all');
  });

  it('shows a paused-segment error and lets the user clear that URL filter', () => {
    mocks.leadError = new Error('Segmentação não encontrada');
    render(<MemoryRouter initialEntries={['/leads?segmentIds=seg-paused&segmentMatch=any']}><Routes><Route path="/leads" element={<><LeadsPage /><CurrentSearch /></>} /></Routes></MemoryRouter>);

    expect(screen.getByRole('alert').textContent).toContain('Segmentação não encontrada');
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtro de segmentação' }));
    expect(screen.getByLabelText('URL atual').textContent).not.toContain('segmentIds=');
  });

  it('sends the persisted segment filters to facets and shows active membership badges in each row', () => {
    mocks.leadData = { items: [{ id: 'lead-1', rdUuid: 'rd-1', name: 'Ana', email: null, phone: null, city: null, state: null, company: null, jobTitle: null, tags: [], lifecycleStage: null, opportunity: false, fit: null, interest: null, conversionsCount: 0, firstConversionAt: null, lastConversionAt: null, rdCreatedAt: null, segments: [{ id: 'seg-a', name: 'Ativos' }, { id: 'seg-b', name: 'Eventos' }] }], total: 1, page: 1, pageSize: 50 };
    render(<MemoryRouter initialEntries={['/leads?segmentIds=seg-a%2Cseg-b&segmentMatch=all']}><Routes><Route path="/leads" element={<LeadsPage />} /></Routes></MemoryRouter>);

    expect(mocks.facetQuery).toMatchObject({ segmentIds: ['seg-a', 'seg-b'], segmentMatch: 'all' });
    const row = screen.getByRole('button', { name: /Ana/ });
    expect(within(row).getByText('Ativos')).toBeTruthy();
    expect(within(row).getByText('Eventos')).toBeTruthy();
  });

  it('edits city, state, and both conversion date bounds in the URL', () => {
    render(<MemoryRouter initialEntries={['/leads']}><Routes><Route path="/leads" element={<><LeadsPage /><CurrentSearch /></>} /></Routes></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Filtros/ }));

    fireEvent.change(screen.getByLabelText('Cidade'), { target: { value: 'Londrina' } });
    fireEvent.change(screen.getByLabelText('UF'), { target: { value: 'PR' } });
    fireEvent.change(screen.getByLabelText('Última conversão desde'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('Última conversão até'), { target: { value: '2026-09-28' } });
    fireEvent.change(screen.getByLabelText('Classificação IA'), { target: { value: 'quente' } });

    expect(screen.getByText('Datas no fuso America/Sao_Paulo')).toBeTruthy();
    const url = screen.getByLabelText('URL atual').textContent ?? '';
    expect(url).toContain('cidade=Londrina');
    expect(url).toContain('uf=PR');
    expect(url).toContain('de=2026-09-01');
    expect(url).toContain('ate=2026-09-28');
    expect(url).toContain('aiScore=quente');
  });

  it('allows typing both UF characters without crashing on the partial URL value', () => {
    render(<MemoryRouter initialEntries={['/leads']}><Routes><Route path="/leads" element={<><LeadsPage /><CurrentSearch /></>} /></Routes></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Filtros/ }));

    const uf = screen.getByLabelText('UF');
    fireEvent.change(uf, { target: { value: 'P' } });
    expect(screen.getByLabelText('UF')).toHaveProperty('value', 'P');
    fireEvent.change(screen.getByLabelText('UF'), { target: { value: 'PR' } });
    expect(screen.getByLabelText('UF')).toHaveProperty('value', 'PR');
    expect(screen.getByLabelText('URL atual').textContent).toContain('uf=PR');
  });

  it('exports the complete list with the active filters, not only the current page', async () => {
    render(<MemoryRouter initialEntries={['/leads?cidade=Londrina&segmentIds=seg-a%2Cseg-b&segmentMatch=all&aiScore=quente&page=3']}><Routes><Route path="/leads" element={<LeadsPage />} /></Routes></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Filtros/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    await waitFor(() => expect(mocks.exportLeads).toHaveBeenCalledWith(expect.objectContaining({ cidade: 'Londrina', segmentIds: ['seg-a', 'seg-b'], segmentMatch: 'all', aiScore: 'quente', page: 3 })));
  });

  it('restores saved filters and saves the current filters without pagination', () => {
    render(<MemoryRouter initialEntries={['/leads?cidade=Curitiba&page=4']}><Routes><Route path="/leads" element={<><LeadsPage /><CurrentSearch /></>} /></Routes></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Filtros/ }));
    fireEvent.change(screen.getByLabelText('Visões salvas'), { target: { value: 'view-1' } });
    expect(screen.getByLabelText('URL atual').textContent).toContain('cidade=Londrina');
    expect(screen.getByLabelText('URL atual').textContent).toContain('aiScore=quente');
    fireEvent.change(screen.getByLabelText('Nome da visão'), { target: { value: 'Minha visão' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar visão' }));
    expect(mocks.saveMutate).toHaveBeenCalledWith(expect.objectContaining({ name: 'Minha visão', filters: expect.not.objectContaining({ page: expect.anything(), pageSize: expect.anything() }) }), expect.anything());
  });

  it('does not show an export error when the user cancels the save dialog', async () => {
    mocks.exportLeads.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
    render(<MemoryRouter initialEntries={['/leads']}><Routes><Route path="/leads" element={<LeadsPage />} /></Routes></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Filtros/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Exportar CSV' }));

    await waitFor(() => expect(mocks.exportLeads).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
