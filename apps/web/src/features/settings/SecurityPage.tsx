import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/apiClient';
import form from '../../components/form.module.scss';
import ui from '../../components/ui.module.scss';
import styles from './SecurityPage.module.scss';

type Status = { enabled: boolean; recoveryCodesRemaining: number };
type Setup = { secret: string; otpauthUri: string };

export function SecurityPage(): React.ReactElement {
  const [status, setStatus] = useState<Status | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [secureActionMode, setSecureActionMode] = useState<'disable' | 'recovery-codes' | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function reload() { setStatus(await api.get<Status>('/auth/totp')); }
  useEffect(() => { void reload().catch(() => setError('Não foi possível carregar as opções de segurança.')); }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await action(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Não foi possível atualizar a segurança.'); }
    finally { setBusy(false); }
  }

  function beginSetup(event: React.FormEvent) {
    event.preventDefault();
    void run(async () => { setSetup(await api.post<Setup>('/auth/totp/setup', { password })); setPassword(''); setCode(''); });
  }

  function enable(event: React.FormEvent) {
    event.preventDefault();
    void run(async () => { const result = await api.post<{ recoveryCodes: string[] }>('/auth/totp/enable', { code }); setRecoveryCodes(result.recoveryCodes); setSetup(null); setCode(''); setMessage('Verificação em duas etapas ativada. Guarde os códigos de recuperação.'); await reload(); });
  }

  function secureAction(path: 'disable' | 'recovery-codes') {
    return (event: React.FormEvent) => {
      event.preventDefault();
      void run(async () => {
        if (path === 'disable') { await api.post('/auth/totp/disable', { password, code }); setRecoveryCodes([]); setMessage('Verificação em duas etapas desativada.'); }
        else { const result = await api.post<{ recoveryCodes: string[] }>('/auth/totp/recovery-codes', { password, code }); setRecoveryCodes(result.recoveryCodes); setMessage('Novos códigos gerados. Os anteriores foram invalidados.'); }
        setPassword(''); setCode(''); setSecureActionMode(null); await reload();
      });
    };
  }

  return <section className={`${ui.page} ${styles.page}`}>
    <header><h1 className={ui.title}>Segurança</h1><p className={ui.muted}>Proteja seu acesso com um aplicativo autenticador.</p></header>
    {message && <p className={styles.success} role="status">{message}</p>}{error && <p className={styles.error} role="alert">{error}</p>}
    {status && <div className={styles.panel}>
      <h2>Verificação em duas etapas</h2>
      {status.enabled ? <>
        <p>Ativada. Códigos de recuperação restantes: {status.recoveryCodesRemaining}.</p>
        {!secureActionMode ? <div className={styles.actions}><button className={form.save} type="button" onClick={() => setSecureActionMode('recovery-codes')}>Gerar novos códigos</button><button className={form.save} type="button" onClick={() => setSecureActionMode('disable')}>Desativar 2FA</button></div> : <form className={styles.form} onSubmit={secureAction(secureActionMode)}>
          <h3>{secureActionMode === 'disable' ? 'Desativar 2FA' : 'Gerar novos códigos de recuperação'}</h3><p className={styles.note}>{secureActionMode === 'disable' ? 'Confirme com sua senha e um código atual ou de recuperação.' : 'Isso invalida os códigos anteriores. Confirme com sua senha e um código atual ou de recuperação.'}</p>
          <div className={form.field}><label className={form.label} htmlFor="secure-password">Senha</label><input id="secure-password" className={form.control} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          <div className={form.field}><label className={form.label} htmlFor="secure-code">Código do autenticador ou de recuperação</label><input id="secure-code" className={form.control} value={code} onChange={(e) => setCode(e.target.value.trim())} autoComplete="one-time-code" required /></div>
          <button className={form.save} type="submit" disabled={busy}>{busy ? 'Salvando…' : secureActionMode === 'disable' ? 'Desativar 2FA' : 'Gerar códigos'}</button>
          <button className={form.save} type="button" onClick={() => { setSecureActionMode(null); setPassword(''); setCode(''); }}>Cancelar</button>
        </form>}
      </> : setup ? <>
        <p>Adicione esta conta ao seu aplicativo autenticador. Digite a chave manualmente ou abra o link no dispositivo.</p>
        <code className={styles.secret}>{setup.secret}</code>
        <p><a href={setup.otpauthUri}>Abrir aplicativo autenticador</a></p>
        <form className={styles.form} onSubmit={enable}>
          <div className={form.field}><label className={form.label} htmlFor="setup-code">Código de seis dígitos</label><input id="setup-code" className={form.control} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} pattern="[0-9]{6}" maxLength={6} required /></div>
          <button className={form.save} type="submit" disabled={busy}>{busy ? 'Verificando…' : 'Ativar verificação'}</button>
        </form>
      </> : <>
        <p>A configuração é opcional e só passa a valer depois que você confirmar um código do aplicativo.</p>
        <form className={styles.form} onSubmit={beginSetup}>
          <div className={form.field}><label className={form.label} htmlFor="setup-password">Confirme sua senha</label><input id="setup-password" className={form.control} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          <button className={form.save} type="submit" disabled={busy}>{busy ? 'Preparando…' : 'Configurar autenticador'}</button>
        </form>
      </>}
      {!!recoveryCodes.length && <div><h3>Guarde estes códigos</h3><p className={styles.note}>Cada código pode ser usado uma vez. Eles não serão exibidos novamente.</p><ul className={styles.codes}>{recoveryCodes.map((value) => <li key={value}><code>{value}</code></li>)}</ul><button type="button" className={form.save} onClick={() => setRecoveryCodes([])}>Já guardei</button></div>}
    </div>}
  </section>;
}
