import form from '../../components/form.module.scss';
import ui from '../../components/ui.module.scss';
import { useState } from 'react';
import type { DailyScheduleState } from '@rd/shared';
import { useAuth } from '../../auth/AuthContext';
import { useDailySync, useRefreshNow, useUpdateRefreshBudget } from './syncApi';

const timeZone = 'America/Sao_Paulo';
const stateLabels: Record<DailyScheduleState, string> = { scheduled: 'Agendada', paused: 'Pausada', disabled: 'Desativada', unavailable: 'Indisponível' };
const statusLabels: Record<string, string> = { queued: 'Na fila', running: 'Em andamento', partial: 'Parcial', failed: 'Falhou', completed: 'Concluída', paused: 'Pausada' };
const stepLabels: Record<string, string> = { details: 'Dados do contato', funnel: 'Funil', conversions: 'Conversões', opportunities: 'Oportunidades', complete: 'Concluindo histórico' };

function date(value: string | null): string {
  return value ? new Date(value).toLocaleString('pt-BR', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'Não registrada';
}

export function DailySyncPanel(): React.ReactElement {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const query = useDailySync();
  const refresh = useRefreshNow();
  const updateBudget = useUpdateRefreshBudget();
  const view = query.data;
  const [budgetInput, setBudgetInput] = useState('');
  const canChange = !!view?.enabled && view.refresh.state === 'scheduled';
  const budget = Number(budgetInput || view?.refresh.budget.limit || 1);
  const budgetValid = Number.isInteger(budget) && budget >= 1 && budget <= 100_000;
  const exhausted = !!view && view.refresh.budget.used >= view.refresh.budget.limit;

  return <section aria-labelledby="daily-sync-heading" style={{ marginBottom: 28 }}>
    <h2 id="daily-sync-heading">Refresh diário de leads</h2>
    <p className={ui.muted}>A rotina percorre leads em lotes; uma base grande pode levar várias execuções diárias até avançar. A próxima tentativa é um horário de execução, não uma promessa de conclusão em 24 horas.</p>
    {query.isLoading && <p role="status">Carregando sincronização diária…</p>}
    {query.error && <p className={ui.alert} role="alert">Não foi possível carregar a sincronização diária: {query.error instanceof Error ? query.error.message : 'Falha desconhecida'}</p>}
    {!query.isLoading && !query.error && !view && <p className={ui.alert} role="alert">Sincronização diária indisponível.</p>}
    {view && <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12, marginBottom: 16 }}>
        <article className={ui.card} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          <strong>Refresh</strong>
          <p>{stateLabels[view.refresh.state]}</p>
          <p>Próxima tentativa: <time dateTime={view.refresh.nextRunAt ?? undefined}>{date(view.refresh.nextRunAt)}</time></p>
          <p>Última conclusão: <time dateTime={view.refresh.lastCompletedAt ?? undefined}>{date(view.refresh.lastCompletedAt)}</time></p>
          <p>{view.refresh.budget.used} de {view.refresh.budget.limit} chamadas</p>
          <p className={ui.muted}>Orçamento renova em <time dateTime={view.refresh.budget.resetsAt}>{date(view.refresh.budget.resetsAt)}</time></p>
        </article>
        <article className={ui.card} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          <strong>Catálogo de segmentações</strong>
          <p>{stateLabels[view.catalog.state]}</p>
          <p>Próxima tentativa: <time dateTime={view.catalog.nextRunAt ?? undefined}>{date(view.catalog.nextRunAt)}</time></p>
          <p>Última tentativa: <time dateTime={view.catalog.lastAttemptAt ?? undefined}>{date(view.catalog.lastAttemptAt)}</time></p>
          <p>Último sucesso: <time dateTime={view.catalog.lastCompletedAt ?? undefined}>{date(view.catalog.lastCompletedAt)}</time></p>
          <p>{view.catalog.budget.used} de {view.catalog.budget.limit} chamadas</p>
          {view.catalog.error && <p className={ui.alert} role="alert">{view.catalog.error}</p>}
        </article>
      </div>
      {view.refresh.run && <article className={ui.card} style={{ minWidth: 0, overflowWrap: 'anywhere', marginBottom: 16 }}>
        <strong>Execução atual</strong>
        <p role={view.refresh.run.error ? 'alert' : 'status'}>{statusLabels[view.refresh.run.status] ?? view.refresh.run.status}{view.refresh.run.error ? `: ${view.refresh.run.error}` : ''}</p>
        <p>{view.refresh.run.leadsCompleted} leads processados</p>
        <p>{view.refresh.run.step ? stepLabels[view.refresh.run.step] ?? 'Etapa não informada' : 'Etapa não informada'}{view.refresh.run.page == null ? '' : ` · página ${view.refresh.run.page}`}</p>
      </article>}
      {view.refresh.state === 'paused' && <p className={ui.alert} role="status">Refresh pausado. Revise a conexão com o RD.</p>}
      {view.refresh.state === 'unavailable' && <p className={ui.alert} role="status">Refresh indisponível no momento.</p>}
      {!admin && <p className={ui.muted}>Somente leitura</p>}
      {admin && <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: 12 }}>
        <button className={ui.btnPrimary} disabled={!canChange || exhausted || refresh.isPending} onClick={() => refresh.mutate()}>{refresh.isPending ? 'Enfileirando…' : 'Solicitar refresh'}</button>
        <label style={{ display: 'grid', gap: 4 }}>Limite diário (1–100.000)
          <input className={form.control} aria-label="Limite diário" type="number" min="1" max="100000" step="1" value={budgetInput || view.refresh.budget.limit} onChange={(event) => setBudgetInput(event.target.value)} style={{ maxWidth: '100%' }} />
        </label>
        <button className={ui.btnPrimary} disabled={!canChange || !budgetValid || updateBudget.isPending} onClick={() => updateBudget.mutate(budget)}>{updateBudget.isPending ? 'Salvando…' : 'Salvar orçamento'}</button>
      </div>}
      {exhausted && <p className={ui.muted} role="status">Orçamento diário esgotado; o refresh manual será liberado após a renovação.</p>}
      {refresh.error && <p className={ui.alert} role="alert">Não foi possível solicitar refresh: {refresh.error instanceof Error ? refresh.error.message : 'Falha desconhecida'}</p>}
      {updateBudget.error && <p className={ui.alert} role="alert">Não foi possível salvar o orçamento: {updateBudget.error instanceof Error ? updateBudget.error.message : 'Falha desconhecida'}</p>}
      {refresh.isSuccess && <p className={ui.muted} role="status">Refresh enfileirado; ainda não foi concluído.</p>}
      {updateBudget.isSuccess && <p className={ui.muted} role="status">Orçamento diário atualizado.</p>}
    </>}
  </section>;
}
