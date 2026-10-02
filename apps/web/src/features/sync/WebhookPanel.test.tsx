import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookStatusView } from '@rd/shared';
import { WebhookPanel } from './WebhookPanel';

const mocks = vi.hoisted(() => ({
  role: 'admin', data: null as WebhookStatusView | null, loading: false, error: null as unknown,
  register: vi.fn(), retry: vi.fn(), registerPending: false, retryPending: false,
}));

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { role: mocks.role } }) }));
vi.mock('./syncApi', () => ({
  useWebhookStatus: () => ({ data: mocks.data, isLoading: mocks.loading, error: mocks.error }),
  useRegisterWebhooks: () => ({ mutate: mocks.register, isPending: mocks.registerPending }),
  useRetryWebhook: () => ({ mutate: mocks.retry, isPending: mocks.retryPending }),
}));

const view = (overrides: Partial<WebhookStatusView> = {}): WebhookStatusView => ({
  configured: true, registeredAt: '2026-09-28T12:00:00.000Z', registrationError: null,
  worker: 'running', pending: 2, failed: 1,
  lastReceivedAt: '2026-09-28T13:00:00.000Z', lastProcessedAt: '2026-09-28T12:55:00.000Z',
  failures: [{ id: 'event-1', eventType: 'WEBHOOK.CONVERTED', receivedAt: '2026-09-28T13:00:00.000Z', attempts: 3 }],
  ...overrides,
});

describe('WebhookPanel', () => {
  beforeEach(() => {
    Object.assign(mocks, { role: 'admin', data: view(), loading: false, error: null, registerPending: false, retryPending: false });
    mocks.register.mockClear(); mocks.retry.mockClear();
  });

  it('shows webhook receipt and processing as separate facts, failures, and incomplete-coverage limits', () => {
    render(<WebhookPanel />);
    expect(screen.getByRole('heading', { name: 'Eventos em tempo real' })).toBeTruthy();
    expect(screen.getByText('Disponível')).toBeTruthy();
    expect(screen.getByText('2 pendentes · 1 com falha')).toBeTruthy();
    expect(screen.getByText(/Último evento recebido:/).textContent).toContain('28/09/2026, 10:00');
    expect(screen.getByText(/Último evento processado:/).textContent).toContain('28/09/2026, 09:55');
    expect(screen.getByText('Conversão')).toBeTruthy();
    expect(screen.queryByText('WEBHOOK.CONVERTED')).toBeNull();
    expect(screen.getByText(/3 tentativas/)).toBeTruthy();
    expect(screen.getByText(/Os eventos recebidos não confirmam atualização completa nem cobertura/)).toBeTruthy();
    expect(screen.getByText(/O RD não envia mudanças feitas manualmente/)).toBeTruthy();
  });

  it('mostra tempo real inativo e oferece Ativar tempo real', () => {
    mocks.data = view({ configured: false });
    render(<WebhookPanel />);
    expect(screen.getByText('Tempo real inativo')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ativar tempo real' }));
    expect(mocks.register).toHaveBeenCalledOnce();
  });

  it('shows loading and errors', () => {
    mocks.loading = true; const { rerender } = render(<WebhookPanel />);
    expect(screen.getByText(/Carregando eventos do RD/)).toBeTruthy();
    mocks.loading = false; mocks.error = new Error('Falha de rede'); rerender(<WebhookPanel />);
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível carregar os eventos do RD');
  });

  it('shows a stopped worker state', () => {
    mocks.data = view({ worker: 'stopped' }); render(<WebhookPanel />);
    expect(screen.getByText('Indisponível')).toBeTruthy();
  });

  it('lets admins explicitly register subscriptions and retry one failed event', () => {
    render(<WebhookPanel />);
    expect(mocks.register).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Verificar tempo real/ }));
    fireEvent.click(screen.getByRole('button', { name: /Tentar novamente/ }));
    expect(mocks.register).toHaveBeenCalledOnce();
    expect(mocks.retry).toHaveBeenCalledWith('event-1');
  });

  it.each([
    ['WEBHOOK.CONVERTED', 'Conversão'],
    ['WEBHOOK.MARKED_OPPORTUNITY', 'Oportunidade'],
    ['UNKNOWN.EVENT', 'Evento RD'],
  ])('uses a product label for %s', (eventType, label) => {
    mocks.data = view({ failures: [{ id: 'event-2', eventType, receivedAt: '2026-09-28T13:00:00.000Z', attempts: 1 }] });
    render(<WebhookPanel />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText(eventType)).toBeNull();
  });

  it('keeps viewers read-only', () => {
    mocks.role = 'viewer'; render(<WebhookPanel />);
    expect(screen.queryByRole('button', { name: /tempo real/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Tentar novamente/ })).toBeNull();
    expect(screen.getByText('Somente leitura')).toBeTruthy();
  });

  it('does not render registration secrets, URLs, or event payloads', () => {
    mocks.data = view({ registrationError: 'Falha ao registrar' }); render(<WebhookPanel />);
    expect(screen.queryByText(/https?:\/\//)).toBeNull();
    expect(screen.queryByText(/token|secret|payload/i)).toBeNull();
  });
});
