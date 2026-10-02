import { Link } from 'react-router-dom';
import ui from '../../components/ui.module.scss';
import { useAiDistribution } from './dashboardApi';

const rows = [['quente', '🔥 Quente'], ['morno', 'Morno'], ['frio', 'Frio']] as const;

export function AiDistributionCard(): React.ReactElement {
  const { data, isLoading, error } = useAiDistribution();
  const classified = data ? data.quente + data.morno + data.frio : 0;
  return <section className={ui.card} aria-labelledby="ai-distribution-title">
    <h2 id="ai-distribution-title">Classificação por IA</h2>
    {isLoading && <p role="status" className={ui.muted}>Carregando…</p>}
    {error && <div className={ui.alert} role="alert">Não foi possível carregar a classificação.</div>}
    {data && !data.configured && classified === 0 && <p className={ui.muted} role="status">IA não configurada. <Link to="/configuracao/ia">Configurar IA</Link></p>}
    {data && (data.configured || classified > 0) && <>
      <p className={ui.muted}>{classified} de {data.total} leads classificados{data.pending ? ` · ${data.pending} na fila` : ''}{data.failed ? ` · ${data.failed} com falha` : ''}.</p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        {rows.map(([key, label]) => {
          const n = data[key];
          const pct = classified ? Math.round((n / classified) * 100) : 0;
          return <li key={key}><Link to={`/leads?aiScore=${key}`}>{label}</Link>: <strong>{n}</strong> ({pct}%)
            <div aria-hidden style={{ height: 6, borderRadius: 3, background: 'var(--c-border)' }}><div style={{ width: `${pct}%`, height: 6, borderRadius: 3, background: 'var(--c-primary)' }} /></div></li>;
        })}
      </ul>
    </>}
  </section>;
}
