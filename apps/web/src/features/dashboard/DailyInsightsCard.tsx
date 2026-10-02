import ui from '../../components/ui.module.scss';
import { useDailyInsights } from './dashboardApi';

export function DailyInsightsCard({ segmentIds }: { segmentIds: string[] }): React.ReactElement {
  const { data, isLoading, error } = useDailyInsights(segmentIds);
  return <section className={ui.card} aria-labelledby="daily-insights-title">
    <h2 id="daily-insights-title">Insights diários</h2>
    <p className={ui.muted}>Métricas dos últimos 7 dias completos comparadas aos 7 anteriores. Os números vêm dos dados importados e usam o fuso de cada snapshot.</p>
    {isLoading && <p role="status" className={ui.muted}>Carregando snapshots…</p>}
    {error && <div className={ui.alert} role="alert">Não foi possível carregar os snapshots diários.</div>}
    {!isLoading && !error && !data?.length && <p className={ui.muted}>Os primeiros insights serão gerados após a próxima atualização diária.</p>}
    {!!data?.length && <div>
      {data.map((snapshot) => <article key={snapshot.id}>
        <h3>{snapshot.scope.type === 'base' ? 'Base completa' : snapshot.scope.name} · {snapshot.snapshotDate}</h3>
        <p className={ui.muted}>{snapshot.contextText}</p>
        {snapshot.bullets?.length ? <ul>{snapshot.bullets.map((bullet, index) => <li key={`${snapshot.id}-${index}`}>{bullet}</li>)}</ul> : <p className={ui.muted}>{snapshot.error ? 'As métricas foram salvas; a seleção de insights de IA falhou.' : 'Snapshot salvo; insights ainda não disponíveis.'}</p>}
      </article>)}
    </div>}
  </section>;
}
