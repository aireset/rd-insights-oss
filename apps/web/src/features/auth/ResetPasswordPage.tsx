import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../../lib/apiClient';
import form from '../../components/form.module.scss';
import styles from './Auth.module.scss';

export function ResetPasswordPage(): React.ReactElement {
  const [token, setToken] = useState(() => window.location.hash.slice(1) || new URLSearchParams(window.location.search).get('token') || '');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (window.location.hash || window.location.search) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError(null); setBusy(true);
    try {
      await api.post('/auth/password-reset/confirm', { token, password });
      setToken(''); setPassword(''); setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível redefinir a senha. Solicite um novo link.');
    } finally { setBusy(false); }
  };

  return (
    <div className={styles.wrap}><div className={styles.inner}>
      <div className={styles.logo}>RD</div>
      <div className={styles.nome}>RD Insights</div>
      <div className={styles.sub}>Redefinição de acesso</div>
      <form className={styles.card} onSubmit={submit}>
        <h1>Nova senha</h1>
        {done ? <><p className={styles.success} role="status">Senha redefinida. Entre com a nova senha.</p><Link to="/login">Ir para entrar</Link></> : !token ? <><p className={styles.muted}>Link inválido ou ausente.</p><Link to="/recuperar-senha">Solicitar novo link</Link></> : <>
          {error && <div className={form.alert} role="alert">{error}</div>}
          <div className={form.field}><label className={form.label} htmlFor="new-password">Nova senha</label><input id="new-password" className={form.control} type="password" autoComplete="new-password" minLength={10} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} required /></div>
          <button className={`${form.save} ${form.full}`} type="submit" disabled={busy}>{busy ? 'Salvando…' : 'Redefinir senha'}</button>
        </>}
      </form>
    </div></div>
  );
}
