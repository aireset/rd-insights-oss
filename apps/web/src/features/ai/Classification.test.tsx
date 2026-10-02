import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClassificationPage, ClassificationPanel } from './Classification';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), role: 'admin' }));
vi.mock('../../lib/apiClient', () => ({ api: mocks }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { role: mocks.role } }) }));
const policy = { currency: 'USD', inputUsdPerMillion: null, outputUsdPerMillion: null, enabled: true, monthlyBudgetCents: 1000, requestsPerMinute: 10, committedMicros: '15000', pending: 3, failed: 1, error: 'Configure os preços', runtime: { redis: 'up', worker: 'running' } };
const lead = { score: 'morno', reason: 'Dados parciais', summary: 'Resultado anterior', model: 'mock', classifiedAt: '2026-09-29T00:00:00Z', status: 'failed', error: 'Resposta inválida', dataUsed: ['Atributos importados'], nextAttemptAt: null };
function show(element: React.ReactNode) { render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{element}</QueryClientProvider></MemoryRouter>); }
describe('classification UI', () => {
  beforeEach(() => { mocks.role = 'admin'; mocks.get.mockReset(); mocks.put.mockReset().mockResolvedValue(policy); mocks.post.mockReset().mockResolvedValue({ status: 'pending' }); });
  it('requires explicit USD prices and saves only pricing fields', async () => {
    mocks.get.mockResolvedValue(policy); show(<ClassificationPage />);
    await screen.findByText('Configure os preços');
    fireEvent.change(screen.getByLabelText('Entrada — USD por milhão de tokens'), { target: { value: '1.25' } });
    fireEvent.change(screen.getByLabelText('Saída — USD por milhão de tokens'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar preços' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/ai/classification/policy', { inputUsdPerMillion: '1.25', outputUsdPerMillion: '2' }));
    expect(screen.getByText(/Reservas de chamadas/)).toBeTruthy();
  });
  it('preserves previous result beside the failure and supports explicit admin retry', async () => {
    mocks.get.mockResolvedValue(lead); show(<ClassificationPanel leadId="lead-1" />);
    await screen.findByText('Resultado anterior');
    expect(screen.getByText('Resposta inválida')).toBeTruthy();
    expect(screen.getByText(/sugestão de IA/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reclassificar' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/ai/classification/leads/lead-1/retry', {}));
  });
  it('hides mutation and pricing for viewers', async () => {
    mocks.role = 'viewer'; mocks.get.mockResolvedValue(lead); show(<><ClassificationPage /><ClassificationPanel leadId="lead-1" /></>);
    await screen.findByText('Resultado anterior');
    expect(screen.queryByRole('button', { name: 'Reclassificar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Salvar preços' })).toBeNull();
    expect(mocks.get).not.toHaveBeenCalledWith('/ai/classification/policy');
  });
  it('avisa "IA não configurada" na ficha e na tela de classificação', async () => {
    mocks.get.mockResolvedValue({ ...lead, configured: false, score: null, status: 'not_requested', error: null });
    show(<ClassificationPanel leadId="lead-1" />);
    expect(await screen.findByText(/IA não configurada/)).toBeTruthy();
  });
  it('"Classificar todos" dispara o lote só com IA e preços configurados', async () => {
    mocks.get.mockResolvedValue({ ...policy, inputUsdPerMillion: '1.00', outputUsdPerMillion: '2.00' });
    mocks.post.mockResolvedValue({ total: 7, started: true });
    show(<ClassificationPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Classificar todos' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/ai/classification/all'));
    expect(await screen.findByText(/7 leads enfileirados/)).toBeTruthy();
  });
});
