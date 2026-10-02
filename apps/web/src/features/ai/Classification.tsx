import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { api } from '../../lib/apiClient';
import form from '../../components/form.module.scss';
import ui from '../../components/ui.module.scss';

interface Policy { currency: string; inputUsdPerMillion: string | null; outputUsdPerMillion: string | null; enabled: boolean; monthlyBudgetCents: number; requestsPerMinute: number; committedMicros: string; cooldownUntil: string | null; pending: number; failed: number; error: string | null; runtime: { redis: string; worker: string } }
interface Classification { configured: boolean; score: string | null; reason: string | null; summary: string | null; classifiedAt: string | null; model: string | null; status: string; error: string | null; nextAttemptAt: string | null; dataUsed: string[] }
const date = (value: string) => new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const states: Record<string, string> = { not_requested: 'Ainda não solicitada', pending: 'Aguardando processamento', processing: 'Classificando', completed: 'Concluída', failed: 'Precisa de atenção', superseded: 'Dados mudaram; aguardando nova classificação' };

export function ClassificationPage(): React.ReactElement {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['classification-policy'], queryFn: () => api.get<Policy>('/ai/classification/policy'), enabled: admin, refetchInterval: 5000 });
  const [draft, setDraft] = useState<{ inputUsdPerMillion: string; outputUsdPerMillion: string } | null>(null);
  const value = draft ?? { inputUsdPerMillion: query.data?.inputUsdPerMillion ?? '', outputUsdPerMillion: query.data?.outputUsdPerMillion ?? '' };
  const save = useMutation({ mutationFn: () => api.put('/ai/classification/policy', value), onSuccess: async () => { setDraft(null); await client.invalidateQueries({ queryKey: ['classification-policy'] }); } });
  const all = useMutation({ mutationFn: () => api.post<{ total: number; started: boolean }>('/ai/classification/all'), onSuccess: async () => { await client.invalidateQueries({ queryKey: ['classification-policy'] }); } });
  if (!admin) return <p className={ui.alert}>A configuração de preços é exclusiva do administrador.</p>;
  const p = query.data;
  return <>
    <h1 className={ui.title}>Classificação de leads</h1>
    <p className={ui.muted}>Cada lead é classificado uma vez por conjunto de dados, mesmo quando pertence a várias segmentações. <Link to="/configuracao/ia">Configurar provider e limite mensal</Link></p>
    {query.isLoading && <p className={ui.muted}>Carregando…</p>}
    {query.error && <p className={ui.alert} role="alert">Não foi possível carregar o estado da classificação.</p>}
    {p && <div className={ui.card} style={{ maxWidth: 680, marginBottom: 16 }}>
      <h2>Estado atual</h2>
      <dl style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '6px 12px' }}><dt className={ui.muted}>Provider</dt><dd>{p.enabled ? 'Habilitado' : 'Desabilitado'}</dd><dt className={ui.muted}>Processamento</dt><dd>{p.runtime?.redis === 'up' && p.runtime.worker === 'running' ? 'Disponível' : 'Indisponível'}</dd><dt className={ui.muted}>Pendentes / falhas</dt><dd>{p.pending} / {p.failed}</dd><dt className={ui.muted}>Limite por minuto</dt><dd>{p.requestsPerMinute}</dd><dt className={ui.muted}>Orçamento mensal USD</dt><dd>{(p.monthlyBudgetCents / 100).toFixed(2)}</dd><dt className={ui.muted}>Comprometido no mês USD</dt><dd>{(Number(p.committedMicros) / 1_000_000).toFixed(6)}</dd></dl>
      <p className={ui.muted}>Reservas de chamadas sem uso confirmado continuam comprometidas. O mês segue UTC; os valores e o orçamento são em dólares americanos (USD).</p>
      {p.cooldownUntil && new Date(p.cooldownUntil).getTime() > Date.now() && <p>Provider em espera até {date(p.cooldownUntil)}.</p>}
      {p.error && <p className={ui.alert} role="alert">{p.error}</p>}
    </div>}
    {p && (!p.enabled || p.inputUsdPerMillion === null) && <p className={ui.alert} role="status">IA não configurada: {p.enabled ? 'informe os preços abaixo.' : <>ative o provider em <Link to="/configuracao/ia">Configuração de IA</Link> e informe os preços.</>}</p>}
    {p && <div className={ui.card} style={{ maxWidth: 680, marginBottom: 16 }}>
      <h2>Classificar todos</h2>
      <p className={ui.muted}>Enfileira todos os leads ainda sem classificação. O processamento respeita o limite por minuto e continua sozinho, mesmo se você sair desta tela. Pode gerar custo.</p>
      <button className={form.save} disabled={all.isPending || !p.enabled || p.inputUsdPerMillion === null} onClick={() => all.mutate()}>Classificar todos</button>
      {all.isSuccess && <p role="status">{all.data.total} leads enfileirados{all.data.started ? '' : ' (já havia um lote em andamento)'}.</p>}
      {all.error && <p className={ui.alert} role="alert">Não foi possível iniciar a classificação.</p>}
    </div>}
    <form className={ui.card} style={{ maxWidth: 680 }} onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <h2>Preços declarados</h2><p className={ui.muted}>Informe os preços do seu contrato. Sem ambos os preços, nenhuma classificação será enviada. Zero é aceito somente para uso gratuito.</p>
      <label className={form.field}><span className={form.label}>Entrada — USD por milhão de tokens</span><input className={form.control} required inputMode="decimal" pattern="[0-9]{1,6}(\.[0-9]{1,6})?" value={value.inputUsdPerMillion} onChange={(e) => setDraft({ ...value, inputUsdPerMillion: e.target.value })} /></label>
      <label className={form.field}><span className={form.label}>Saída — USD por milhão de tokens</span><input className={form.control} required inputMode="decimal" pattern="[0-9]{1,6}(\.[0-9]{1,6})?" value={value.outputUsdPerMillion} onChange={(e) => setDraft({ ...value, outputUsdPerMillion: e.target.value })} /></label>
      {save.error && <p className={ui.alert} role="alert">Não foi possível salvar os preços.</p>}
      {save.isSuccess && <p role="status">Preços salvos.</p>}
      <button className={form.save} disabled={save.isPending || query.isLoading || !!query.error}>Salvar preços</button>
    </form>
  </>;
}

export function ClassificationPanel({ leadId }: { leadId: string }): React.ReactElement {
  const { user } = useAuth();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['classification', leadId], queryFn: () => api.get<Classification>(`/ai/classification/leads/${leadId}`), refetchInterval: 5000 });
  const retry = useMutation({ mutationFn: () => api.post(`/ai/classification/leads/${leadId}/retry`, {}), onSuccess: async () => { await client.invalidateQueries({ queryKey: ['classification', leadId] }); } });
  const c = query.data;
  return <section className={ui.card} style={{ marginTop: 16, overflowWrap: 'anywhere' }}>
    <h2>Classificação comercial</h2>
    <p className={ui.muted}>Esta é uma sugestão de IA baseada nos dados disponíveis. Revise antes de tomar decisões.</p>
    {query.isLoading && <p className={ui.muted}>Carregando classificação…</p>}
    {query.error && <p className={ui.alert} role="alert">Não foi possível consultar a classificação.</p>}
    {c && c.configured === false && !c.score && <p className={ui.alert} role="status">IA não configurada. {user?.role === 'admin' ? <Link to="/ia/classificacao">Configurar</Link> : 'Peça a um administrador para configurar.'}</p>}
    {c && (c.configured !== false || c.score) && <><p role="status">{states[c.status] ?? c.status}</p>{c.score && <><span className="chip">{c.score}</span><p>{c.reason}</p><p>{c.summary}</p><p className="muted">{c.classifiedAt ? date(c.classifiedAt) : 'Data não registrada'} · Modelo: {c.model ?? 'Não registrado'}</p></>}
      {c.error && <p className={ui.alert} role="alert">{c.error}</p>}
      {c.nextAttemptAt && <p className={ui.muted}>Próxima tentativa: {date(c.nextAttemptAt)}</p>}
      <p className={ui.muted}>Dados utilizados: {c.dataUsed.join('; ')}. Campos ausentes não são inferidos.</p>
    </>}
    {user?.role === 'admin' && <><p className={ui.muted}>Uma nova solicitação pode gerar custo, inclusive com os mesmos dados. <Link to="/ia/classificacao">Preços e orçamento</Link></p><button className={form.cancel} disabled={retry.isPending || c?.status === 'processing'} onClick={() => retry.mutate()}>Reclassificar</button></>}
    {retry.error && <p className={ui.alert} role="alert">Não foi possível solicitar a classificação.</p>}
    {retry.isSuccess && <p role="status">Solicitação registrada.</p>}
  </section>;
}
