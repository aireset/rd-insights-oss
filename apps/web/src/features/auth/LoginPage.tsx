import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import type { AuthConfig } from '@rd/shared';
import { useAuth } from '../../auth/AuthContext';
import { api, ApiError } from '../../lib/apiClient';
import form from '../../components/form.module.scss';
import styles from './Auth.module.scss';

export function LoginPage(): React.ReactElement {
  const { login, verifyTwoFactor, status } = useAuth();
  const { data: authConfig } = useQuery({ queryKey: ['auth', 'config'], queryFn: () => api.get<AuthConfig>('/auth/config') });
  const navigate = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [challengeToken, setChallengeToken] = useState(''); const [code, setCode] = useState('');
  const [erro, setErro] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  if (status === 'authenticated') return <Navigate to="/" replace />;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErro(null); setBusy(true);
    try {
      if (challengeToken) await verifyTwoFactor(challengeToken, code);
      else {
        const challenge = await login({ email, password });
        if (challenge) { setChallengeToken(challenge.challengeToken); return; }
      }
      navigate((loc.state as { from?: string } | null)?.from ?? '/', { replace: true });
    }
    catch (err) { setErro(err instanceof ApiError ? err.message : 'Não foi possível entrar'); }
    finally { setBusy(false); }
  };
  return (
    <div className={styles.wrap}><div className={styles.inner}>
      <div className={styles.logo}>RD</div>
      <div className={styles.nome}>RD Insights</div>
      <div className={styles.sub}>Painel de leads do RD Station Marketing</div>
      <form className={styles.card} onSubmit={submit}>
        <h1>{challengeToken ? 'Verificação em duas etapas' : 'Entrar'}</h1>
        {erro && <div className={form.alert}>{erro}</div>}
        {challengeToken ? <>
          <p>Digite o código do aplicativo autenticador ou um código de recuperação.</p>
          <div className={form.field}><label className={form.label} htmlFor="two-factor-code">Código de verificação</label><input id="two-factor-code" className={form.control} type="text" inputMode="text" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.trim())} required autoFocus /></div>
          <button className={`${form.save} ${form.full}`} type="submit" disabled={busy}>{busy ? 'Verificando…' : 'Verificar'}</button>
          <p className={styles.foot}><button className={styles.linkButton} type="button" onClick={() => { setChallengeToken(''); setCode(''); setErro(null); }}>Voltar ao login</button></p>
        </> : <>
          <div className={form.field}><label className={form.label} htmlFor="email">E-mail</label><input id="email" className={form.control} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div className={form.field}><label className={form.label} htmlFor="password">Senha</label><input id="password" className={form.control} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          <button className={`${form.save} ${form.full}`} type="submit" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
          <p className={styles.foot}><Link to="/recuperar-senha">Esqueci minha senha</Link></p>
          {authConfig?.smtpConfigured === false && <p className={styles.foot} role="note">Envio de e-mail não configurado: a recuperação de senha está indisponível. Peça a redefinição ao administrador.</p>}
          {authConfig?.registrationOpen && <p className={styles.foot}>Sem conta? <Link to="/registrar">Criar conta</Link></p>}
        </>}
      </form>
    </div></div>
  );
}
