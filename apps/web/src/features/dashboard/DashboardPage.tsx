import { Fragment } from 'react';
import { useSearchParams } from 'react-router-dom';
import form from '../../components/form.module.scss';
import ui from '../../components/ui.module.scss';
import { useRdConnection } from '../onboarding/rdApi';
import { useSegmentCoverage } from '../sync/syncApi';
import { AiDistributionCard } from './AiDistributionCard';
import { DailyInsightsCard } from './DailyInsightsCard';
import { useDashboardSummary, useNewLeads, useRdAnalytics, useSegmentComparison } from './dashboardApi';
import styles from './DashboardPage.module.scss';

const periods = [7, 30, 90] as const;
type Period = (typeof periods)[number];
const coverageLabels = { unknown: 'Desconhecida', partial: 'Parcial', complete: 'Completa' } as const;

function coverageDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'Ainda não registrada';
}

export function DashboardPage(): React.ReactElement {
  const [search, setSearch] = useSearchParams();
  const period = periods.includes(Number(search.get('period')) as Period) ? Number(search.get('period')) as Period : 30;
  const segmentIds = search.get('segmentIds')?.split(',').filter(Boolean) ?? [];
  const segmentMatch: 'any' | 'all' = search.get('segmentMatch') === 'all' ? 'all' : 'any';
  const segmentAId = search.get('compareA') ?? '';
  const segmentBId = search.get('compareB') ?? '';
  const query = { period, segmentIds: segmentIds.length ? segmentIds : undefined, segmentMatch };
  const { data, isLoading, error } = useNewLeads(query);
  const { data: summary, isLoading: summaryLoading, error: summaryError } = useDashboardSummary(query);
  const { data: connection } = useRdConnection();
  const rdAnalytics = useRdAnalytics();
  const coverage = useSegmentCoverage();
  const segments = connection?.segmentations.filter((segment) => segment.selected && segment.available) ?? [];
  const { data: comparison, isLoading: comparisonLoading, error: comparisonError } = useSegmentComparison(segmentAId, segmentBId);
  const max = Math.max(1, ...(data?.points.map((point) => point.count) ?? []));
  const heat = new Map(summary?.heatmap.map((cell) => [`${cell.dayOfWeek}:${cell.hour}`, cell.count]) ?? []);
  const heatMax = Math.max(1, ...heat.values());
  const credentialOrigin = connection?.credencialOrigem === 'painel' ? 'painel' : connection?.credencialOrigem === 'env' ? '.env' : 'não identificada';
  const set = (patch: { period?: Period; segmentIds?: string[]; segmentMatch?: 'any' | 'all' }) => {
    const next = new URLSearchParams(search);
    if (patch.period) next.set('period', String(patch.period));
    if (patch.segmentMatch) next.set('segmentMatch', patch.segmentMatch);
    if (patch.segmentIds?.length) next.set('segmentIds', patch.segmentIds.join(','));
    else if ('segmentIds' in patch) next.delete('segmentIds');
    setSearch(next);
  };
  const toggleSegment = (id: string, checked: boolean) => {
    const next = new Set(segmentIds);
    if (checked) next.add(id); else next.delete(id);
    set({ segmentIds: [...next] });
  };
  const setComparison = (key: 'compareA' | 'compareB', id: string) => {
    const next = new URLSearchParams(search);
    if (id) next.set(key, id); else next.delete(key);
    setSearch(next);
  };

  return <div className={styles.dashboard}>
    <h1 className={ui.title}>Dashboard</h1>
    <section className={`${ui.card} ${styles.section}`} aria-labelledby="dashboard-coverage-title">
      <h2 id="dashboard-coverage-title" className={styles.sectionTitle}>Atualização e cobertura por segmento</h2>
      <p className={ui.muted}>Origem: RD Station Marketing · credenciais via {credentialOrigin}. A cobertura descreve memberships registrados; não representa uma coorte histórica.</p>
      {coverage.isLoading && <p role="status" aria-label="Carregando atualização dos segmentos…">Carregando atualização dos segmentos…</p>}
      {coverage.error && <div className={ui.alert} role="alert">Não foi possível carregar a atualização dos segmentos.</div>}
      {!coverage.isLoading && !coverage.error && !coverage.data?.length && <p className={ui.muted}>Nenhum segmento registrado.</p>}
      {!!coverage.data?.length && <div className={styles.coverageGrid}>
        {coverage.data.map((segment) => <article className={`${ui.card} ${styles.coverageCard}`} key={segment.id}>
          <h3>{segment.name}</h3>
          <p>Cobertura {coverageLabels[segment.coverage].toLowerCase()}</p>
          <p className={ui.muted}>Leitura de participação: <time dateTime={segment.lastScanAt ?? undefined}>{coverageDate(segment.lastScanAt)}</time></p>
          <p className={ui.muted}>Última reconciliação: <time dateTime={segment.lastDeltaSyncAt ?? undefined}>{coverageDate(segment.lastDeltaSyncAt)}</time></p>
        </article>)}
      </div>}
    </section>
    <div className={`${ui.toolbar} ${styles.filters}`}>
      <label className={styles.filterField}><span className={form.label}>Período</span>
        <select className={`${form.control} ${styles.filterControl}`} aria-label="Período" value={period} onChange={(event) => set({ period: Number(event.target.value) as Period })}>
          {periods.map((days) => <option key={days} value={days}>{days} dias</option>)}
        </select>
      </label>
      <fieldset className={styles.segments}><legend className={styles.legend}>Segmentações</legend>
        {segments.map((segment) => <label key={segment.id} className={styles.segmentOption}>
          <input type="checkbox" aria-label={segment.name} checked={segmentIds.includes(segment.id)} onChange={(event) => toggleSegment(segment.id, event.target.checked)} /> {segment.name}
        </label>)}
        {!segments.length && <span className={ui.muted}>Nenhuma ativa</span>}
      </fieldset>
      <label className={styles.filterField}><span className={form.label}>Correspondência</span>
        <select className={`${form.control} ${styles.filterControl}`} aria-label="Segmentação corresponde" value={segmentMatch} onChange={(event) => set({ segmentMatch: event.target.value as 'any' | 'all' })}>
          <option value="any">Em qualquer segmento</option><option value="all">Em todos os segmentos</option>
        </select>
      </label>
    </div>
    <AiDistributionCard />
    <DailyInsightsCard segmentIds={segmentIds} />
    <section className={`${ui.card} ${styles.section}`} aria-labelledby="rd-analytics-title">
      <h2 id="rd-analytics-title" className={styles.sectionTitle}>Analytics GLOBAL RD · janela de 30 dias</h2>
      <p className={ui.muted}>Dados consolidados pelo RD Station, sem filtro de segmentação. Atualização diária; o RD pode levar até 24 horas para consolidar.</p>
      {rdAnalytics.isLoading && <p className={ui.muted}>Carregando analytics RD…</p>}
      {rdAnalytics.error && <div className={ui.alert} role="alert">Não foi possível carregar o cache de analytics RD.</div>}
      {rdAnalytics.data && <div className={styles.grid}>
        {(['conversions', 'funnel'] as const).map((type) => {
          const item = rdAnalytics.data[type];
          const payload = item.data as Record<string, unknown> | null;
          const conversionRows = payload && Array.isArray(payload.conversions) ? payload.conversions as Array<Record<string, unknown>> : [];
          const funnelRows = payload && Array.isArray(payload.funnel) ? payload.funnel as Array<Record<string, unknown>> : [];
          const dates = payload?.query_date as { start_date?: string; end_date?: string } | undefined;
          const metric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('pt-BR') : 'indisponível';
          return <article className={`${ui.card} ${styles.section}`} key={type}>
            <h3>{type === 'conversions' ? 'Ativos de conversão' : 'Funil de vendas'}</h3>
            {item.error && <p className={ui.muted}>{item.error} {item.data ? 'Exibindo o último dado salvo.' : ''}</p>}
            {item.stale && item.data && !item.error && <p className={ui.muted}>Último dado disponível; atualização diária pendente.</p>}
            {!item.data && !item.error && <p className={ui.muted}>Aguardando a primeira coleta diária.</p>}
            {item.fetchedAt && <p className={ui.muted}>Última coleta: {coverageDate(item.fetchedAt)}</p>}
            {dates?.start_date && dates.end_date && <p className={ui.muted}>Período coletado: {dates.start_date} a {dates.end_date} (UTC).</p>}
            {!!conversionRows.length && <ul className={styles.rank}>{conversionRows.map((row, index) => <li key={String(row.asset_id ?? index)}><span>{String(row.asset_identifier ?? row.asset_type ?? 'Ativo')}</span><strong>{metric(row.visits_count)} visitas · {metric(row.conversions_count)} conversões · taxa {metric(row.conversion_rate)}{typeof row.conversion_rate === 'number' ? '%' : ''}</strong></li>)}</ul>}
            {!!funnelRows.length && <ul className={styles.rank}>{funnelRows.map((row, index) => <li key={String(row.reference_day ?? index)}><span>{String(row.reference_day ?? 'Data não informada')}</span><strong>{metric(row.visitors_count)} visitantes · {metric(row.contacts_count)} leads · {metric(row.qualified_contacts_count)} qualificados · {metric(row.opportunities_count)} oportunidades · {metric(row.sales_count)} vendas</strong></li>)}</ul>}
            {!!payload && !conversionRows.length && !funnelRows.length && <p className={ui.muted}>O RD não retornou linhas de analytics neste período.</p>}
          </article>;
        })}
      </div>}
    </section>
    <section className={`${ui.card} ${styles.section}`} aria-labelledby="segment-comparison-title">
      <h2 id="segment-comparison-title" className={styles.sectionTitle}>Comparar segmentações</h2>
      <div className={`${ui.toolbar} ${styles.comparisonFilters}`}>
        <label className={styles.filterField}><span className={form.label}>Segmentação A</span>
          <select className={form.control} aria-label="Segmentação A" value={segmentAId} onChange={(event) => setComparison('compareA', event.target.value)}>
            <option value="">Selecione A</option>{segments.map((segment) => <option key={segment.id} value={segment.id}>{segment.name}</option>)}
          </select>
        </label>
        <label className={styles.filterField}><span className={form.label}>Segmentação B</span>
          <select className={form.control} aria-label="Segmentação B" value={segmentBId} onChange={(event) => setComparison('compareB', event.target.value)}>
            <option value="">Selecione B</option>{segments.map((segment) => <option key={segment.id} value={segment.id}>{segment.name}</option>)}
          </select>
        </label>
      </div>
      <p className={ui.muted}>Membros refletem a associação atual registrada; não representam uma coorte histórica.</p>
      {comparisonError && <div className={ui.alert} role="alert">Falha ao comparar segmentações.</div>}
      {comparisonLoading && segmentAId && segmentBId && <p className={ui.muted}>Carregando comparação…</p>}
      {comparison && <ul className={styles.rank} aria-label="Resultado da comparação">
        <li><span>Leads em A</span><strong>{comparison.a.toLocaleString('pt-BR')}</strong></li>
        <li><span>Leads em B</span><strong>{comparison.b.toLocaleString('pt-BR')}</strong></li>
        <li><span>Sobreposição</span><strong>{comparison.overlap.toLocaleString('pt-BR')}</strong></li>
        <li><span>União de leads únicos</span><strong>{comparison.union.toLocaleString('pt-BR')}</strong></li>
      </ul>}
    </section>
    {error && <div className={ui.alert} role="alert">Falha ao carregar novos leads.</div>}
    {summaryError && <div className={ui.alert} role="alert">Falha ao carregar os dados de distribuição.</div>}
    <section className={`${ui.card} ${styles.section}`} aria-labelledby="new-leads-title">
      <h2 id="new-leads-title" className={styles.sectionTitle}>Novos leads · {data?.timeZone ?? 'America/Sao_Paulo'}</h2>
      {isLoading ? <p className={ui.muted}>Carregando…</p> : data && <>
        <p><strong>{data.total.toLocaleString('pt-BR')} novos leads</strong> <span className={ui.muted}>nos últimos {period} dias</span></p>
        <ol className={styles.bars} aria-label={`Novos leads por dia nos últimos ${period} dias`}>
          {data.points.map((point) => <li key={point.date} title={`${point.date}: ${point.count} ${point.count === 1 ? 'lead' : 'leads'}`} style={{ height: `${Math.max(4, point.count / max * 100)}%` }}><span className={styles.srOnly}>{point.date}: {point.count}</span></li>)}
        </ol>
        <div className={styles.axis}><span>{data.points[0]?.date ?? '—'}</span><span>{data.points.at(-1)?.date ?? '—'}</span></div>
      </>}
    </section>
    <p className={ui.muted}>Estágios, tags e cidades mostram o estado atual dos leads nos segmentos; conversões e horários usam o período selecionado e o fuso informado.</p>
    <div className={styles.grid}>
      <section className={`${ui.card} ${styles.section}`}><h2 className={styles.sectionTitle}>Estágios atuais</h2>{summaryLoading ? <p className={ui.muted}>Carregando…</p> : <ul className={styles.rank}>{summary?.stages.map((item) => <li key={item.name}><span>{item.name}</span><strong>{item.count}</strong></li>)}{summary && !summary.stages.length && <li className={ui.muted}>Sem dados.</li>}</ul>}</section>
      <section className={`${ui.card} ${styles.section}`}><h2 className={styles.sectionTitle}>Conversões mais frequentes</h2>{summaryLoading ? <p className={ui.muted}>Carregando…</p> : <ul className={styles.rank}>{summary?.conversions.map((item) => <li key={item.identifier}><span>{item.identifier}</span><strong>{item.leadCount} leads</strong></li>)}{summary && !summary.conversions.length && <li className={ui.muted}>Sem dados.</li>}</ul>}</section>
      <section className={`${ui.card} ${styles.section}`}><h2 className={styles.sectionTitle}>Tags atuais</h2>{summaryLoading ? <p className={ui.muted}>Carregando…</p> : <ul className={styles.rank}>{summary?.tags.map((item) => <li key={item.name}><span>{item.name}</span><strong>{item.leadCount} leads</strong></li>)}{summary && !summary.tags.length && <li className={ui.muted}>Sem dados.</li>}</ul>}</section>
      <section className={`${ui.card} ${styles.section}`}><h2 className={styles.sectionTitle}>Cidades e estados atuais</h2>{summaryLoading ? <p className={ui.muted}>Carregando…</p> : <ul className={styles.rank}>{summary?.locations.map((item) => <li key={`${item.city}:${item.state}`}><span>{[item.city, item.state].filter(Boolean).join(' / ')}</span><strong>{item.leadCount} leads</strong></li>)}{summary && !summary.locations.length && <li className={ui.muted}>Sem dados.</li>}</ul>}</section>
    </div>
    <section className={`${ui.card} ${styles.section}`}><h2 className={styles.sectionTitle}>Conversões por dia e hora <span className={ui.muted}>· {summary?.timeZone ?? 'America/Sao_Paulo'}</span></h2>
      {summaryLoading ? <p className={ui.muted}>Carregando…</p> : summary && !summary.heatmap.length ? <p className={ui.muted}>Sem conversões nesse período.</p> : summary && <div className={styles.heatScroll}>
        <div className={styles.heatmap} role="img" aria-label={`Mapa de calor de conversões por dia da semana e hora em ${summary.timeZone}`}><span />{Array.from({ length: 24 }, (_, hour) => <span key={hour} className={styles.heatHour}>{hour}</span>)}
          {['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((day, dayOfWeek) => <Fragment key={day}><span className={styles.heatDay}>{day}</span>{Array.from({ length: 24 }, (_, hour) => {
            const count = heat.get(`${dayOfWeek}:${hour}`) ?? 0;
            return <span key={hour} className={styles.heatCell} title={`${day} ${hour}h ${summary.timeZone}: ${count} conversões`} style={{ opacity: count ? 0.25 + count / heatMax * 0.75 : 0.08 }} />;
          })}</Fragment>)}
        </div>
      </div>}
    </section>
  </div>;
}
