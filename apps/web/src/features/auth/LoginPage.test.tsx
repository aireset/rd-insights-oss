import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/apiClient';
import { LoginPage } from './LoginPage';

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ login: vi.fn(), verifyTwoFactor: vi.fn(), status: 'anonymous' }) }));
vi.mock('../../lib/apiClient', () => ({ api: { get: vi.fn() }, ApiError: class ApiError extends Error {} }));

const show = () => render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><LoginPage /></MemoryRouter></QueryClientProvider>);

describe('LoginPage e-mail não configurado', () => {
  it('avisa quando o servidor não tem SMTP', async () => {
    vi.mocked(api.get).mockResolvedValue({ registrationOpen: false, smtpConfigured: false });
    show();
    expect(await screen.findByText(/Envio de e-mail não configurado/)).toBeTruthy();
  });

  it('não avisa quando o SMTP está configurado', async () => {
    vi.mocked(api.get).mockResolvedValue({ registrationOpen: false, smtpConfigured: true });
    show();
    await screen.findByText('Esqueci minha senha');
    expect(screen.queryByText(/Envio de e-mail não configurado/)).toBeNull();
  });
});
