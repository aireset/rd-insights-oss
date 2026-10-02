import ui from '../../components/ui.module.scss';
import form from '../../components/form.module.scss';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { DailySyncPanel } from './DailySyncPanel';
import { WebhookPanel } from './WebhookPanel';
import { useReconcileNow, useReconciliationRuns, useReconciliationSchedule, useSegmentCoverage } from './syncApi';

const timeZone = 'America/Sao_Paulo';
const scheduleLabels = { scheduled: 'Agendada', disabled: 'Desativada', unavailable: 'Indisponível', paused: 'Pausada' } as const;
const runLabels = { queued: 'Na fila', running: 'Em andamento', partial: 'Parcial', failed: 'Falhou', completed: 'Concluída', paused: 'Pausada' } as const;
const coverageLabels = { unknown: 'Desconhecida', partial: 'Parcial', complete: 'Completa' } as const;

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('pt-BR', { timeZone }) : 'Ainda não registrada';
}

function runStatus(run: { status?: string; error: string | null; finishedAt: string | null }): string {
  const status = run.status ?? (run.error ? 'failed' : run.finishedAt ? 'partial' : 'running');
  return runLabels[status as keyof typeof runLabels] ?? status;
}

function coverageDate(value: string | null): string {
  return value ? formatDate(value) : 'Não registrada';
}

export function SyncSchedulePage(): React.ReactElement {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const schedule = useReconciliationSchedule();
  const coverage = useSegmentCoverage();
  const reconcile = useReconcileNow();
  const [segmentId, setSegmentId] = useState('');
  const [status, setStatus] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const runs = useReconciliationRuns({ cursor: cursors[pageIndex], pageSize: 20, segmentId: segmentId || undefined, status: status ? status as 'queued' | 'running' | 'partial' | 'failed' | 'completed' | 'paused' : undefined });
  const view = schedule.data;
  const canReconcile = admin && view?.enabled && view.state === 'scheduled';

  return <div className={ui.page}>
    <h1 className={ui.title}>Sincronização</h1>
    <DailySyncPanel />
    <WebhookPanel />
    <section aria-labelledby="sync-schedule-heading">
      <h2 id="sync-schedule-heading">Reconciliação de segmentos</h2>
      <p className={ui.muted}>Atualiza a participação dos leads nos segmentos e as conversões detectáveis. Isso não confirma atualização de todos os campos nem define prazo para terminar. Com carga ativa, a solicitação pode ser agrupada e aguardar a próxima tentativa.</p>
      <p className={ui.muted}>Horários em {timeZone}.</p>

      {schedule.isLoading && <p role="status">Carregando agenda…</p>}
      {schedule.error && <p className={ui.alert} role="alert">Não foi possível carregar a agenda: {schedule.error instanceof Error ? schedule.error.message : 'Falha desconhecida'}</p>}
      {!schedule.isLoading && !schedule.error && !view && <p className={ui.alert} role="alert">Agenda indisponível.</p>}
      {view && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12, marginBottom: 16 }}>
        <article className={ui.card} style={{ minWidth: 0 }}>
          <strong>Status</strong>
          <p>{scheduleLabels[view.state]}</p>
          <p className={ui.muted}>Intervalo: {view.intervalMinutes} minutos</p>
        </article>
        <article className={ui.card} style={{ minWidth: 0 }}>
          <strong>Próxima tentativa</strong>
          <p><time dateTime={view.nextRunAt ?? undefined}>{view.nextRunAt ? formatDate(view.nextRunAt) : 'Sem próxima tentativa'}</time></p>
        </article>
        <article className={ui.card} style={{ minWidth: 0 }}>
          <strong>Solicitada em</strong>
          <p><time dateTime={view.lastAttemptAt ?? undefined}>{formatDate(view.lastAttemptAt)}</time></p>
        </article>
        <article className={ui.card} style={{ minWidth: 0 }}>
          <strong>Última atualização automática</strong>
          <p><time dateTime={view.lastCompletedAt ?? undefined}>{formatDate(view.lastCompletedAt)}</time></p>
        </article>
      </div>}

      {view?.state === 'paused' && <p className={ui.alert} role="status">Revise a conexão e os segmentos selecionados para retomar a reconciliação. <Link to="/conectar">Conectar RD</Link></p>}
      {view?.state === 'unavailable' && <p className={ui.alert} role="status">Serviço de sincronização indisponível no momento. Tente novamente mais tarde.</p>}
      {view?.state === 'disabled' && <p className={ui.muted} role="status">O agendamento está desativado.</p>}
      {admin ? <button className={ui.btnPrimary} disabled={!canReconcile || reconcile.isPending} onClick={() => reconcile.mutate()}>{reconcile.isPending ? 'Enfileirando…' : 'Reconciliar agora'}</button> : <p className={ui.muted}>Somente leitura</p>}
      {reconcile.error && <p className={ui.alert} role="alert">Não foi possível solicitar reconciliação: {reconcile.error instanceof Error ? reconcile.error.message : 'Falha desconhecida'}</p>}
      {reconcile.isSuccess && <p className={ui.muted} role="status">Solicitação enviada para a fila; a execução ainda não foi concluída.</p>}
    </section>

    <section aria-labelledby="segment-coverage-heading" style={{ marginTop: 28 }}>
      <h2 id="segment-coverage-heading">Leitura e cobertura por segmento</h2>
      <p className={ui.muted}>A leitura completa confirma a participação dos leads nos segmentos; ela não significa que todos os campos dos leads estejam atualizados.</p>
      {coverage.isLoading && <p role="status">Carregando cobertura dos segmentos…</p>}
      {coverage.error && <p className={ui.alert} role="alert">Não foi possível carregar a cobertura: {coverage.error instanceof Error ? coverage.error.message : 'Falha desconhecida'}</p>}
      {!coverage.isLoading && !coverage.error && !coverage.data?.length && <p className={ui.muted}>Nenhum segmento registrado.</p>}
      {!!coverage.data?.length && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 }}>
        {coverage.data.map((segment) => <article className={ui.card} key={segment.id} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          <strong>{segment.name}</strong>
          <p>{coverageLabels[segment.coverage]}</p>
          <p className={ui.muted}>{segment.selected ? 'Selecionado' : 'Não selecionado'} · {segment.available ? 'Disponível' : 'Não disponível'}</p>
          <p>Última leitura de participação: <time dateTime={segment.lastScanAt ?? undefined}>{coverageDate(segment.lastScanAt)}</time></p>
          <p>Última reconciliação bem-sucedida: <time dateTime={segment.lastDeltaSyncAt ?? undefined}>{coverageDate(segment.lastDeltaSyncAt)}</time></p>
        </article>)}
      </div>}
    </section>

    <section aria-labelledby="sync-runs-heading" style={{ marginTop: 28 }}>
      <h2 id="sync-runs-heading">Histórico de sincronizações</h2>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <label className={form.field} style={{ minWidth: 220, flex: '1 1 220px' }}>
          <span className={form.label}>Segmento</span>
          <select className={form.control} value={segmentId} onChange={(event) => { setSegmentId(event.target.value); setCursors([undefined]); setPageIndex(0); }}>
            <option value="">Todos os segmentos</option>
            {coverage.data?.map((segment) => <option value={segment.id} key={segment.id}>{segment.name}</option>)}
          </select>
        </label>
        <label className={form.field} style={{ minWidth: 220, flex: '1 1 220px' }}>
          <span className={form.label}>Status</span>
          <select className={form.control} value={status} onChange={(event) => { setStatus(event.target.value); setCursors([undefined]); setPageIndex(0); }}>
            <option value="">Todos os status</option>
            {Object.entries(runLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
        </label>
      </div>
      {runs.isLoading && <p role="status">Carregando execuções…</p>}
      {runs.error && <p className={ui.alert} role="alert">Não foi possível carregar as execuções: {runs.error instanceof Error ? runs.error.message : 'Falha desconhecida'}</p>}
      {!runs.isLoading && !runs.error && !runs.data?.items.length && <p className={ui.muted}>Nenhuma execução encontrada para estes filtros.</p>}
      {!!runs.data?.items.length && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 12 }}>
        {runs.data.items.map((run) => <article className={ui.card} key={run.id} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          <strong>Segmento {run.segmentId ?? 'sem identificador'}</strong>
          <p role={run.error ? 'alert' : 'status'}>{runStatus(run)}{run.error ? `: ${run.error}` : ''}</p>
          <p className={ui.muted}>Tipo: {run.kind}</p>
          <p className={ui.muted}><time dateTime={run.startedAt}>{formatDate(run.startedAt)}</time></p>
          <p>{run.stats.lidos} lidos · {run.stats.criados} criados · {run.stats.atualizados} atualizados · {run.stats.erros} erros</p>
          {run.stats.totalPaginas != null ? <p className={ui.muted}>Página {run.cursor} de {run.stats.totalPaginas}</p> : <p className={ui.muted}>{run.cursor} páginas processadas</p>}
        </article>)}
      </div>}
      <nav aria-label="Paginação do histórico" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 16 }}>
        <button className={ui.btnSecondary} disabled={pageIndex === 0 || runs.isFetching} onClick={() => setPageIndex((page) => page - 1)}>Anterior</button>
        <span className={ui.muted}>Página {pageIndex + 1}</span>
        <button className={ui.btnSecondary} disabled={!runs.data?.nextCursor || runs.isFetching} onClick={() => {
          const next = runs.data?.nextCursor;
          if (!next) return;
          setCursors((current) => [...current.slice(0, pageIndex + 1), next]);
          setPageIndex((page) => page + 1);
        }}>Próxima</button>
      </nav>
    </section>
  </div>;
}
