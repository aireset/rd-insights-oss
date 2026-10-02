import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from './DashboardPage';

const mocks = vi.hoisted(() => ({
  query: undefined as unknown,
  summaryQuery: undefined as unknown,
  coverage: [] as Array<{ id: string; name: string; selected: boolean; available: boolean; coverage: 'unknown' | 'partial' | 'complete'; lastScanAt: string | null; lastDeltaSyncAt: string | null }>,
  coverageLoading: false,
  coverageError: null as unknown,
  connection: { credencialOrigem: 'env', segmentations: [
    { id: 'seg-a', name: 'Ativos', selected: true, available: true },
    { id: 'seg-b', name: 'Eventos', selected: true, available: true },
  ] },
}));

vi.mock('./dashboardApi', () => ({
  useNewLeads: (query: unknown) => { mocks.query = query; return { data: { total: 2, points: [{ date: '2026-09-27', count: 1 }, { date: '2026-09-28', count: 1 }] }, isLoading: false, error: null }; },
  useDashboardSummary: (query: unknown) => { mocks.summaryQuery = query; return { data: { period: 7, timeZone: 'America/Sao_Paulo', stages: [{ name: 'Lead', count: 2 }], conversions: [{ identifier: 'ebook', leadCount: 1 }], tags: [{ name: 'webinar', leadCount: 2 }], locations: [{ city: 'Londrina', state: 'PR', leadCount: 2 }], heatmap: [{ dayOfWeek: 1, hour: 10, count: 2 }] }, isLoading: false, error: null }; },
  useRdAnalytics: () => ({ data: undefined, isLoading: false, error: null }),
  useDailyInsights: () => ({ data: [], isLoading: false, error: null }),
  useAiDistribution: () => ({ data: { configured: true, total: 10, quente: 2, morno: 3, frio: 1, semClassificacao: 4, pending: 0, failed: 0 }, isLoading: false, error: null }),
  useSegmentComparison: (a: string, b: string) => ({ data: a && b ? { a: 2, b: 2, overlap: 1, union: 3 } : undefined, isLoading: false, error: null }),
}));
vi.mock('../sync/syncApi', () => ({
  useSegmentCoverage: () => ({ data: mocks.coverage, isLoading: mocks.coverageLoading, error: mocks.coverageError }),
}));
vi.mock('../onboarding/rdApi', () => ({ useRdConnection: () => ({ data: mocks.connection }) }));

function CurrentSearch(): React.ReactElement { const { search } = useLocation(); return <output aria-label="URL atual">{search}</output>; }

describe('DashboardPage', () => {
  beforeEach(() => { mocks.query = undefined; mocks.summaryQuery = undefined; mocks.coverage = []; mocks.coverageLoading = false; mocks.coverageError = null; });

  it('shows credential origin and only recorded coverage and update times per segment', () => {
    mocks.coverage = [
      { id: 'seg-a', name: 'Ativos', selected: true, available: true, coverage: 'unknown', lastScanAt: null, lastDeltaSyncAt: null },
      { id: 'seg-b', name: 'Eventos', selected: true, available: true, coverage: 'partial', lastScanAt: '2026-09-28T12:00:00.000Z', lastDeltaSyncAt: null },
    ];
    render(<MemoryRouter initialEntries={['/dashboard']}><Routes><Route path="/dashboard" element={<DashboardPage />} /></Routes></MemoryRouter>);

    expect(screen.getByText(/Origem: RD Station Marketing · credenciais via .env/)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Ativos' })).toBeTruthy();
    expect(screen.getByText((_, element) => element?.tagName === 'P' && element.textContent === 'Cobertura desconhecida')).toBeTruthy();
    expect(screen.getAllByText('Ainda não registrada')).toHaveLength(3);
    expect(screen.getByText((_, element) => element?.tagName === 'P' && element.textContent === 'Cobertura parcial')).toBeTruthy();
    expect(screen.getByText('28/09/2026, 09:00:00')).toBeTruthy();
  });

  it('shows loading, error and empty states for segment freshness', () => {
    mocks.coverageLoading = true;
    const view = render(<MemoryRouter initialEntries={['/dashboard']}><Routes><Route path="/dashboard" element={<DashboardPage />} /></Routes></MemoryRouter>);
    expect(screen.getByRole('status', { name: 'Carregando atualização dos segmentos…' })).toBeTruthy();
    view.unmount();
    mocks.coverageLoading = false;
    mocks.coverageError = new Error('offline');
    const failed = render(<MemoryRouter initialEntries={['/dashboard']}><Routes><Route path="/dashboard" element={<DashboardPage />} /></Routes></MemoryRouter>);
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível carregar a atualização dos segmentos');
    failed.unmount();
    mocks.coverageError = null;
    mocks.coverage = [];
    render(<MemoryRouter initialEntries={['/dashboard']}><Routes><Route path="/dashboard" element={<DashboardPage />} /></Routes></MemoryRouter>);
    expect(screen.getByText('Nenhum segmento registrado.')).toBeTruthy();
  });

  it('filters the daily series by period and multiple selected segments', () => {
    render(<MemoryRouter initialEntries={['/dashboard?period=30&segmentIds=seg-a&segmentMatch=any']}><Routes><Route path="/dashboard" element={<><DashboardPage /><CurrentSearch /></>} /></Routes></MemoryRouter>);

    expect(mocks.query).toMatchObject({ period: 30, segmentIds: ['seg-a'], segmentMatch: 'any' });
    expect(mocks.summaryQuery).toMatchObject({ period: 30, segmentIds: ['seg-a'], segmentMatch: 'any' });
    fireEvent.click(screen.getByLabelText('Eventos'));
    fireEvent.change(screen.getByLabelText('Segmentação corresponde'), { target: { value: 'all' } });
    expect(screen.getByLabelText('URL atual').textContent).toContain('segmentIds=seg-a%2Cseg-b');
    expect(screen.getByLabelText('URL atual').textContent).toContain('segmentMatch=all');
    fireEvent.click(screen.getByLabelText('Ativos'));
    fireEvent.click(screen.getByLabelText('Eventos'));
    expect(screen.getByLabelText('URL atual').textContent).not.toContain('segmentIds=');
  });

  it('shows the selected period, total and day values accessibly', () => {
    render(<MemoryRouter initialEntries={['/dashboard?period=7']}><Routes><Route path="/dashboard" element={<DashboardPage />} /></Routes></MemoryRouter>);

    expect(screen.getByRole('heading', { name: /Dashboard/ })).toBeTruthy();
    expect(mocks.summaryQuery).toMatchObject({ period: 7 });
    expect(screen.getByRole('heading', { name: 'Novos leads · America/Sao_Paulo' })).toBeTruthy();
    expect(screen.getByText('2 novos leads')).toBeTruthy();
    expect(screen.getByLabelText(/Novos leads por dia/)).toBeTruthy();
    expect(screen.getByTitle(/2026-09-27: 1 lead/)).toBeTruthy();
    expect(screen.getByText('ebook')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Mapa de calor.*America\/Sao_Paulo/ })).toBeTruthy();
  });

  it('compara A e B e apresenta contagem atual sem afirmar coorte histórica', () => {
    render(<MemoryRouter initialEntries={['/dashboard']}><Routes><Route path="/dashboard" element={<><DashboardPage /><CurrentSearch /></>} /></Routes></MemoryRouter>);

    fireEvent.change(screen.getByLabelText('Segmentação A'), { target: { value: 'seg-a' } });
    fireEvent.change(screen.getByLabelText('Segmentação B'), { target: { value: 'seg-b' } });
    expect(screen.getByLabelText('URL atual').textContent).toContain('compareA=seg-a');
    expect(screen.getByLabelText('URL atual').textContent).toContain('compareB=seg-b');
    expect(screen.getByText('Leads em A').parentElement?.textContent).toContain('2');
    expect(screen.getByText('Leads em B').parentElement?.textContent).toContain('2');
    expect(screen.getByText('Sobreposição').parentElement?.textContent).toContain('1');
    expect(screen.getByText('União de leads únicos').parentElement?.textContent).toContain('3');
    expect(screen.getByText(/associação atual registrada; não representam uma coorte histórica/)).toBeTruthy();
  });

  it('mostra a distribuição quente/morno/frio da classificação por IA', () => {
    render(<MemoryRouter initialEntries={["/dashboard"]}><Routes><Route path="/dashboard" element={<DashboardPage />} /></Routes></MemoryRouter>);
    expect(screen.getByText('6 de 10 leads classificados.')).toBeTruthy();
    expect(screen.getByRole('link', { name: '🔥 Quente' }).getAttribute('href')).toBe('/leads?aiScore=quente');
  });
});
