import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/apiClient';
import { UsersPage } from './UsersPage';

const auth = vi.hoisted(() => ({ user: { id: 'admin-1', name: 'Ana', email: 'ana@a.test', role: 'admin' as 'admin' | 'viewer', accountId: 'a', accountName: 'A', isSuperAdmin: false } }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../../lib/apiClient', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));

describe('UsersPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lista membros e pendentes, envia convite e altera papel', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => path === '/users' ? [{ id: 'admin-1', name: 'Ana', email: 'ana@a.test', role: 'admin' }] : [{ id: 'i-1', email: 'bia@a.test', role: 'viewer', expiresAt: new Date(Date.now() + 60_000).toISOString() }]);
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    vi.mocked(api.patch).mockResolvedValue({ ok: true });
    render(<MemoryRouter><UsersPage /></MemoryRouter>);
    expect(await screen.findByText('bia@a.test')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('E-mail para convite'), { target: { value: 'caio@a.test' } });
    fireEvent.change(screen.getByLabelText('Papel do convite'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar convite' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/users/invitations', { email: 'caio@a.test', role: 'admin' }));
    fireEvent.change(screen.getByLabelText('Papel de Ana'), { target: { value: 'viewer' } });
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/users/admin-1/role', { role: 'viewer' }));
  });

  it('reenvia e cancela convite; remove outro membro mas não oferece remover a si mesmo', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => path === '/users'
      ? [{ id: 'admin-1', name: 'Ana', email: 'ana@a.test', role: 'admin' }, { id: 'v-1', name: 'Davi', email: 'davi@a.test', role: 'viewer' }]
      : [{ id: 'i-1', email: 'bia@a.test', role: 'viewer', expiresAt: '2026-10-08T00:00:00.000Z' }]);
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    vi.mocked(api.delete).mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<MemoryRouter><UsersPage /></MemoryRouter>);
    expect(await screen.findByText('bia@a.test')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remover Ana' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reenviar convite para bia@a.test' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/users/invitations/i-1/resend'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar convite de bia@a.test' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/users/invitations/i-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Remover Davi' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/users/v-1'));
  });

  it('não mostra gestão de membros para viewer', async () => {
    auth.user.role = 'viewer';
    vi.mocked(api.get).mockResolvedValue([]);
    render(<MemoryRouter><UsersPage /></MemoryRouter>);
    expect(await screen.findByText('Somente administradores podem gerenciar usuários.')).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
    auth.user.role = 'admin';
  });
});
