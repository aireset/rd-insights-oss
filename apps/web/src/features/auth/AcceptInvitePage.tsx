import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../../lib/apiClient';
import form from '../../components/form.module.scss';
import styles from './Auth.module.scss';

export function AcceptInvitePage(): React.ReactElement {
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  useEffect(() => {
    const raw = window.location.hash.slice(1);
    setToken(raw);
    if (raw) window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await api.post('/users/invitations/accept', { token, name, password }); setAccepted(true); setPassword(''); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Não foi possível aceitar o convite.'); }
    finally { setBusy(false); setPassword(''); }
  }

  return <main className={styles.wrap}><div className={styles.inner}>
    <div className={styles.logo}>RD</div>
    <div className={styles.nome}>RD Insights</div>
    <div className={styles.sub}>Acesso à sua conta</div>
    <section className={styles.card}>
      <h1>Aceitar convite</h1>
      {accepted ? <><p className={styles.success} role="status">Convite aceito. Entre com seu e-mail e senha.</p><Link to="/login">Ir para o login</Link></> :
      !token ? <><p className={styles.muted} role="alert">Link de convite inválido ou ausente. Peça um novo convite ao administrador.</p><Link to="/login">Voltar ao login</Link></> : <form onSubmit={(e) => void submit(e)}>
        <div className={form.field}><label className={form.label} htmlFor="invite-name">Nome</label><input id="invite-name" className={form.control} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} autoComplete="name" /></div>
        <div className={form.field}><label className={form.label} htmlFor="invite-password">Senha</label><input id="invite-password" className={form.control} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} maxLength={128} autoComplete="new-password" /></div>
        {error && <div role="alert" className={form.alert}>{error}</div>}
        <button className={`${form.save} ${form.full}`} type="submit" disabled={busy}>{busy ? 'Aceitando…' : 'Aceitar convite'}</button>
      </form>}
      {!accepted && token && <p className={styles.foot}><Link to="/login">Voltar ao login</Link></p>}
    </section>
  </div></main>;
}
