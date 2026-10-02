import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { PasswordResetRequestResponse } from '@rd/shared';
import { ApiError, api } from '../../lib/apiClient';
import form from '../../components/form.module.scss';
import styles from './Auth.module.scss';

export function ForgotPasswordPage(): React.ReactElement {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setMessage(null); setError(null); setBusy(true);
    try {
      const result = await api.post<PasswordResetRequestResponse>('/auth/password-reset/request', { email });
      setMessage(result.message);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? err.message : 'Não foi possível processar a solicitação agora. Tente novamente mais tarde.');
    } finally { setBusy(false); }
  };

  return (
    <div className={styles.wrap}><div className={styles.inner}>
      <div className={styles.logo}>RD</div>
      <div className={styles.nome}>RD Insights</div>
      <div className={styles.sub}>Recuperação de acesso</div>
      <form className={styles.card} onSubmit={submit}>
        <h1>Recuperar senha</h1>
        {message && <div className={styles.success} role="status">{message}</div>}
        {error && <div className={form.alert} role="alert">{error}</div>}
        <div className={form.field}><label className={form.label} htmlFor="reset-email">E-mail</label><input id="reset-email" className={form.control} type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>
        <button className={`${form.save} ${form.full}`} type="submit" disabled={busy}>{busy ? 'Enviando…' : 'Enviar instruções'}</button>
        <p className={styles.foot}>Lembrou a senha? <Link to="/login">Entrar</Link></p>
      </form>
    </div></div>
  );
}
