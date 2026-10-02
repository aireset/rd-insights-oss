import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiConfigPage } from './AiConfigPage';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('../../lib/apiClient', () => ({ api: { get: mocks.get, put: mocks.put } }));

const config = { provider: 'omniroute' as const, baseUrl: 'https://ai.example.com/v1', model: 'fast', enabled: true, monthlyBudgetCents: 2500, requestsPerMinute: 20, hasApiKey: true };

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AiConfigPage /></QueryClientProvider>);
}

describe('AiConfigPage', () => {
  beforeEach(() => { mocks.get.mockReset().mockResolvedValue(config); mocks.put.mockReset().mockResolvedValue(config); });

  it('never fills the saved API key into the form and submits blank to preserve it', async () => {
    renderPage();
    await screen.findByDisplayValue('fast');
    const key = await screen.findByLabelText(/Chave da API/);
    expect((key as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar configuração' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/ai/config', expect.objectContaining({ apiKey: '', model: 'fast' })));
  });
});
