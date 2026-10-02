import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/apiClient';
import { ForgotPasswordPage } from './ForgotPasswordPage';
import { ResetPasswordPage } from './ResetPasswordPage';

vi.mock('../../lib/apiClient', () => ({ api: { post: vi.fn() }, ApiError: class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } } }));

describe('Password reset pages', () => {
  beforeEach(() => vi.clearAllMocks());

  it('solicita recuperação e mostra a mensagem indistinguível do servidor', async () => {
    vi.mocked(api.post).mockResolvedValue({ message: 'Se o endereço estiver cadastrado, você receberá instruções para redefinir a senha.' });
    render(<MemoryRouter><ForgotPasswordPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'ana@acme.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar instruções' }));
    expect(await screen.findByText(/Se o endereço estiver cadastrado/)).toBeTruthy();
    expect(api.post).toHaveBeenCalledWith('/auth/password-reset/request', { email: 'ana@acme.com' });
  });

  it('remove token do fragmento e limpa o formulário após concluir', async () => {
    window.history.replaceState({}, '', '/redefinir-senha#token-muito-secreto');
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    render(<MemoryRouter><ResetPasswordPage /></MemoryRouter>);
    await waitFor(() => expect(window.location.hash).toBe(''));
    fireEvent.change(screen.getByLabelText('Nova senha'), { target: { value: 'senha-nova-forte' } });
    fireEvent.click(screen.getByRole('button', { name: 'Redefinir senha' }));
    expect(await screen.findByText('Senha redefinida. Entre com a nova senha.')).toBeTruthy();
    expect(api.post).toHaveBeenCalledWith('/auth/password-reset/confirm', { token: 'token-muito-secreto', password: 'senha-nova-forte' });
    expect(screen.queryByDisplayValue('senha-nova-forte')).toBeNull();
  });
});
