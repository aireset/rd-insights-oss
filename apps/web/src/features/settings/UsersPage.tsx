import { useCallback, useEffect, useState } from 'react';
import type { AccountMember, PendingInvite } from '@rd/shared';
import { useAuth } from '../../auth/AuthContext';
import { api, ApiError } from '../../lib/apiClient';
import form from '../../components/form.module.scss';
import ui from '../../components/ui.module.scss';
import styles from './UsersPage.module.scss';

export function UsersPage(): React.ReactElement {
  const { user } = useAuth();
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'viewer'>('viewer');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (user?.role !== 'admin') return;
    const [nextMembers, nextInvites] = await Promise.all([api.get<AccountMember[]>('/users'), api.get<PendingInvite[]>('/users/invitations')]);
    setMembers(nextMembers);
    setInvites(nextInvites);
  }, [user?.role]);

  useEffect(() => { void load().catch(() => setError('Não foi possível carregar usuários e convites.')); }, [load]);

  async function invite(event: React.FormEvent) {
    event.preventDefault(); setError(''); setMessage(''); setBusy(true);
    try { await api.post('/users/invitations', { email, role }); setEmail(''); setMessage('Convite enviado.'); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Não foi possível enviar o convite.'); }
    finally { setBusy(false); }
  }

  async function act(run: () => Promise<unknown>, ok: string, fail: string) {
    setError(''); setMessage('');
    try { await run(); setMessage(ok); }
    catch (e) { setError(e instanceof ApiError ? e.message : fail); }
    await load().catch(() => undefined);
  }
  const resend = (id: string) => act(() => api.post(`/users/invitations/${id}/resend`), 'Convite reenviado.', 'Não foi possível reenviar o convite.');
  const cancel = (id: string) => act(() => api.delete(`/users/invitations/${id}`), 'Convite cancelado.', 'Não foi possível cancelar o convite.');
  const remove = (m: AccountMember) => { if (window.confirm(`Remover ${m.name} (${m.email}) da conta?`)) void act(() => api.delete(`/users/${m.id}`), 'Usuário removido.', 'Não foi possível remover o usuário.'); };

  async function changeRole(memberId: string, nextRole: 'admin' | 'viewer') {
    setError(''); setMessage('');
    try { await api.patch(`/users/${memberId}/role`, { role: nextRole }); setMessage('Papel atualizado.'); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Não foi possível atualizar o papel.'); await load().catch(() => undefined); }
  }

  if (user?.role !== 'admin') return <section className={`${ui.page} ${styles.page}`}><h1 className={ui.title}>Usuários</h1><p className={ui.muted} role="status">Somente administradores podem gerenciar usuários.</p></section>;
  return <section className={`${ui.page} ${styles.page}`}>
    <header className={styles.header}><div><h1 className={ui.title}>Usuários da conta</h1><p className={ui.muted}>Gerencie membros e convites desta conta.</p></div></header>
    {message && <p className={styles.success} role="status">{message}</p>}{error && <p className={styles.error} role="alert">{error}</p>}
    <h2 className={styles.sectionTitle}>Membros</h2>
    <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Ações</th></tr></thead><tbody>
      {members.map((member) => <tr key={member.id}><td>{member.name}</td><td>{member.email}</td><td><label className={styles.srOnly} htmlFor={`role-${member.id}`}>Papel de {member.name}</label><select id={`role-${member.id}`} className={form.control} value={member.role} onChange={(e) => void changeRole(member.id, e.target.value as 'admin' | 'viewer')}><option value="admin">Admin</option><option value="viewer">Viewer</option></select></td><td>{member.id !== user?.id && <button type="button" className={form.cancel} onClick={() => remove(member)} aria-label={`Remover ${member.name}`}>Remover</button>}</td></tr>)}
      {!members.length && <tr><td colSpan={4}>Nenhum membro encontrado.</td></tr>}
    </tbody></table></div>
    <h2 className={styles.sectionTitle}>Convidar</h2>
    <form onSubmit={(e) => void invite(e)} className={styles.inviteForm}>
      <div className={form.field}><label className={form.label} htmlFor="invite-email">E-mail para convite</label><input id="invite-email" className={form.control} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></div>
      <div className={form.field}><label className={form.label} htmlFor="invite-role">Papel do convite</label><select id="invite-role" className={form.control} value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'viewer')}><option value="viewer">Viewer</option><option value="admin">Admin</option></select></div>
      <button className={form.save} type="submit" disabled={busy}>{busy ? 'Enviando…' : 'Enviar convite'}</button>
    </form>
    <h2 className={styles.sectionTitle}>Convites pendentes</h2>
    <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>E-mail</th><th>Papel</th><th>Expira</th><th>Ações</th></tr></thead><tbody>
      {invites.map((invite) => <tr key={invite.id}><td>{invite.email}</td><td>{invite.role === 'admin' ? 'Admin' : 'Viewer'}</td><td>{new Date(invite.expiresAt).toLocaleDateString()}</td><td><button type="button" className={form.cancel} onClick={() => void resend(invite.id)} aria-label={`Reenviar convite para ${invite.email}`}>Reenviar</button> <button type="button" className={form.cancel} onClick={() => void cancel(invite.id)} aria-label={`Cancelar convite de ${invite.email}`}>Cancelar</button></td></tr>)}
      {!invites.length && <tr><td colSpan={4}>Nenhum convite pendente.</td></tr>}
    </tbody></table></div>
  </section>;
}
