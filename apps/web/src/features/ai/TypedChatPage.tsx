import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useRdConnection } from '../onboarding/rdApi';
import { api } from '../../lib/apiClient';
import form from '../../components/form.module.scss';
import ui from '../../components/ui.module.scss';
import styles from './TypedChatPage.module.scss';

type Message = { role: 'user' | 'assistant'; content: string };
type Reply = { answer: string; listUrl: string | null; dataUsed: string[]; scope: { segmentIds: string[]; segmentMatch: 'any' | 'all'; segmentNames: string[] }; freshness: { lastFullSyncAt: string | null; lastDeltaSyncAt: string | null } };
const labels: Record<string, string> = { contar_leads: 'contagem de leads', listar_leads: 'lista de leads', tendencia: 'tendência', top: 'principais resultados' };

export function TypedChatPage(): React.ReactElement {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<'any' | 'all'>('any');
  const [reply, setReply] = useState<Reply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const { user } = useAuth();
  const { data: connection } = useRdConnection();
  const segments = connection?.segmentations.filter((s) => s.selected && s.available) ?? [];

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || sending) return;
    const next = [...messages, { role: 'user' as const, content: message }];
    setMessages(next); setDraft(''); setSending(true); setError(null); setReply(null);
    try {
      const result = await api.post<Reply>('/ai/chat', { message, history: messages.slice(-10), context: { segmentIds: selected, segmentMatch: mode } });
      setMessages([...next, { role: 'assistant', content: result.answer }]); setReply(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível consultar a base.');
      setMessages(next);
    } finally { setSending(false); }
  }

  return <div className={ui.page}>
    <h1 className={ui.title}>Pergunte à base</h1>
    <p className={ui.muted}>Consulte sua base de leads. As respostas usam somente leads sincronizados e as ferramentas tipadas disponíveis.</p>
    <section className={ui.card} style={{ maxWidth: 900, marginBottom: 16 }} aria-label="Escopo da consulta">
      <strong>Segmentações</strong>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, margin: '10px 0' }}>
        {segments.length ? segments.map((segment) => <label key={segment.id}>
          <input type="checkbox" checked={selected.includes(segment.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, segment.id] : selected.filter((id) => id !== segment.id))} /> {segment.name}
        </label>) : <span className={ui.muted}>Nenhuma segmentação ativa; consulta considera todos os leads sincronizados.</span>}
      </div>
      <label className={ui.muted}>Quando selecionar várias, o lead deve estar <select className={form.control} aria-label="Modo das segmentações" value={mode} onChange={(event) => setMode(event.target.value as 'any' | 'all')} style={{ width: 'auto' }}><option value="any">em qualquer uma</option><option value="all">em todas</option></select></label>
    </section>
    <section className={ui.card} style={{ maxWidth: 900 }} aria-label="Conversa">
      <div aria-live="polite" className={styles.transcript}>
        {!messages.length && <p className={ui.muted}>Exemplos: “Quantos leads converteram nos últimos 30 dias?” · “Liste os leads de Londrina.” · “Quais tags aparecem mais?”</p>}
        {messages.map((item, index) => <div key={index} className={`${styles.bubble} ${item.role === 'user' ? styles.user : styles.assistant}`}><strong>{item.role === 'user' ? 'Você' : 'RD Insights'}</strong><div>{item.content}</div></div>)}
        {sending && <p role="status" className={ui.muted}>Consultando a base…</p>}
      </div>
      {reply && <div className={`${ui.muted} ${styles.scope}`}>
        <div>{reply.scope.segmentNames.length ? `Segmentações: ${reply.scope.segmentNames.join(reply.scope.segmentMatch === 'all' ? ' + ' : ' ou ')}.` : 'Escopo: todos os leads da conta.'} Último delta: {reply.freshness.lastDeltaSyncAt ? new Date(reply.freshness.lastDeltaSyncAt).toLocaleString('pt-BR') : 'sem registro'} · Carga completa: {reply.freshness.lastFullSyncAt ? new Date(reply.freshness.lastFullSyncAt).toLocaleString('pt-BR') : 'sem registro'}.</div>
        {reply.dataUsed.length > 0 && <span>Dados consultados: {reply.dataUsed.map((tool) => labels[tool] ?? tool).join(', ')}.</span>}{reply.listUrl && <> <Link to={reply.listUrl}>Abrir estes leads na lista</Link></>}
      </div>}
      {error && <p className={ui.alert} role="alert">{error}</p>}
      <form onSubmit={(event) => void send(event)} className={styles.composer}>
        <input className={form.control} aria-label="Sua pergunta" value={draft} maxLength={2000} onChange={(event) => setDraft(event.target.value)} placeholder="Pergunte sobre os leads…" disabled={sending} />
        <button className={form.save} type="submit" disabled={sending || !draft.trim()}>{sending ? 'Consultando…' : 'Perguntar'}</button>
      </form>
      <small className={form.hint} style={{ display: 'block', marginTop: 8 }}>O chat usa a configuração de IA da conta. Custos e chamadas são registrados sem salvar a conversa. {user?.role === 'admin' && <><Link to="/configuracao/ia">Configuração</Link> · <Link to="/ia/classificacao">Classificação</Link></>}</small>
    </section>
  </div>;
}
