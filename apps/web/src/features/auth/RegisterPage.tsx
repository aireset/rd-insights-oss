import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import form from '../../components/form.module.scss';
import styles from './Auth.module.scss';

export function RegisterPage(): React.ReactElement {
  const { register, status } = useAuth();
  const navigate = useNavigate();
  const [f, setF] = useState({ accountName: '', name: '', email: '', password: '' });
  const [erro, setErro] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  if (status === 'authenticated') return <Navigate to="/" replace />;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErro(null); setBusy(true);
    try { await register(f); navigate('/conectar', { replace: true }); }
    catch (err) { setErro(err instanceof ApiError ? (err.errors?.map((x) => `${x.path}: ${x.message}`).join('; ') || err.message) : 'Não foi possível criar a conta'); }
    finally { setBusy(false); }
  };
  return (
    <div className={styles.wrap}><div className={styles.inner}>
      <div className={styles.logo}>RD</div>
      <div className={styles.nome}>RD Insights</div>
      <div className={styles.sub}>Painel de leads do RD Station Marketing</div>
      <form className={styles.card} onSubmit={submit}>
        <h1>Criar conta</h1>
        {erro && <div className={form.alert}>{erro}</div>}
        <div className={form.field}><label className={form.label} htmlFor="accountName">Nome da empresa / conta</label><input id="accountName" className={form.control} value={f.accountName} onChange={set('accountName')} required /></div>
        <div className={form.field}><label className={form.label} htmlFor="name">Seu nome</label><input id="name" className={form.control} value={f.name} onChange={set('name')} required /></div>
        <div className={form.field}><label className={form.label} htmlFor="email">E-mail</label><input id="email" className={form.control} type="email" value={f.email} onChange={set('email')} required /></div>
        <div className={form.field}><label className={form.label} htmlFor="password">Senha (mín. 10)</label><input id="password" className={form.control} type="password" minLength={10} value={f.password} onChange={set('password')} required /></div>
        <button className={`${form.save} ${form.full}`} type="submit" disabled={busy}>{busy ? 'Criando…' : 'Criar conta'}</button>
        <p className={styles.foot}>Já tem conta? <Link to="/login">Entrar</Link></p>
      </form>
    </div></div>
  );
}
