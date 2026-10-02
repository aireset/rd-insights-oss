import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/apiClient';
import { AcceptInvitePage } from './AcceptInvitePage';

vi.mock('../../lib/apiClient', () => ({ api: { post: vi.fn() }, ApiError: class ApiError extends Error {} }));

describe('AcceptInvitePage', () => {
  beforeEach(() => vi.clearAllMocks());
  it('consome token do fragmento e envia criação de usuário sem abrir registro público', async () => {
    const token = 't'.repeat(48);
    window.history.replaceState({}, '', `/aceitar-convite#${token}`);
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    render(<MemoryRouter><AcceptInvitePage /></MemoryRouter>);
    await waitFor(() => expect(window.location.hash).toBe(''));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Bia' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'senha-convite-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Aceitar convite' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/users/invitations/accept', { token, name: 'Bia', password: 'senha-convite-10' }));
    expect(await screen.findByText('Convite aceito. Entre com seu e-mail e senha.')).toBeTruthy();
    expect(screen.queryByDisplayValue('senha-convite-10')).toBeNull();
  });
});
