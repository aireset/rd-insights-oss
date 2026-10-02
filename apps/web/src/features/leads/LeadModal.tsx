import type { LeadDataCoverage, LeadDataEndpointView } from '@rd/shared';
import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Badge } from '../../components/Badge';
import ui from '../../components/ui.module.scss';
import { dataHora } from '../../lib/format';
import { ClassificationPanel } from '../ai/Classification';
import { useLead } from './leadsApi';
import styles from './LeadModal.module.scss';

const timeZone = 'America/Sao_Paulo';
const endpointLabels = { unknown: 'Ainda não verificado', available: 'Disponível', partial: 'Parcial', unavailable: 'Indisponível' } as const;
const sources = [
  ['details', 'Dados do contato'], ['funnel', 'Funil'], ['conversions', 'Conversões'], ['opportunities', 'Oportunidades'],
] as const;

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('pt-BR', { timeZone }) : 'Ainda não registrada';
}

function fieldValue(value: string | number | null, key: LeadDataCoverage['missingFields'][number], coverage: LeadDataCoverage | undefined, endpoint: 'details' | 'funnel', enrichedAt: string | null | undefined): string {
  if (coverage?.[endpoint]?.status === 'available' && coverage.missingFields.includes(key)) return 'Não fornecido pelo RD';
  if (value != null && value !== '') return String(value);
  if (coverage?.missingFields.includes(key)) return 'Não fornecido pelo RD';
  if (!enrichedAt || !coverage || coverage[endpoint]?.status === 'unknown') return 'Ainda não recebido';
  return '—';
}

function EndpointStatus({ label, endpoint }: { label: string; endpoint: LeadDataEndpointView }): React.ReactElement {
  return <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
    <strong>{label}</strong>
    <p>{endpointLabels[endpoint.status]}</p>
    <p className={ui.muted}>Última tentativa: {formatDate(endpoint.checkedAt)}</p>
    {endpoint.reason && <p className={ui.muted}>Motivo informado: {endpoint.reason}</p>}
  </div>;
}

/**
 * Ficha do lead num `<dialog>` nativo: `showModal()` prende o foco e o Esc fecha;
 * clique no fundo (fora do painel) também fecha; o corpo rola por dentro.
 */
export function LeadModal({ id, onClose }: { id: string; onClose: () => void }): React.ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  const { data: l, error } = useLead(id);
  const freshness = l?.dataFreshness;
  const coverage = freshness?.coverage;
  const historyComplete = !!freshness?.historySyncedAt && coverage?.conversions.status === 'available' && coverage.opportunities.status === 'available';
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  return (
    <dialog ref={ref} className={styles.dialog} aria-labelledby="lead-titulo" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className={styles.painel}>
        <header className={styles.head}>
          <h2 id="lead-titulo" className={styles.titulo}>{l ? (l.name ?? '(sem nome)') : 'Lead'}
            {l?.opportunity && <Badge label="oportunidade" variant="success" />}
            {l?.lifecycleStage && <Badge label={l.lifecycleStage} variant="info" />}</h2>
          <button type="button" className={styles.fechar} onClick={onClose} aria-label="Fechar"><X size={20} /></button>
        </header>
        <div className={styles.corpo}>
          {error && <div className={ui.alert}>Lead não encontrado.</div>}
          {!l && !error && <p className={ui.muted}>Carregando…</p>}
          {l && (<>
            <section className={styles.sec}>
              <dl className={styles.kv}>
                <dt>Data de entrada</dt><dd>{dataHora(l.rdCreatedAt ?? l.firstConversionAt)}</dd>
                <dt>Última alteração</dt><dd>{dataHora(l.lastConversionAt)}</dd>
                <dt>E-mail</dt><dd>{fieldValue(l.email, 'email', coverage, 'details', freshness?.enrichedAt)}</dd>
                <dt>Telefone</dt><dd>{fieldValue(l.phone, 'phone', coverage, 'details', freshness?.enrichedAt)}</dd>
                <dt>Empresa</dt><dd>{l.company ?? '—'}</dd>
                <dt>Cargo</dt><dd>{fieldValue(l.jobTitle, 'jobTitle', coverage, 'details', freshness?.enrichedAt)}</dd>
                <dt>Cidade</dt><dd>{[l.city, l.state].filter(Boolean).join(' / ') || '—'}</dd>
                <dt>Fit / interesse</dt><dd>{l.fit ?? '—'} / {l.interest ?? '—'}</dd>
                <dt>UUID</dt><dd className={ui.mono}>{l.rdUuid}</dd>
              </dl>
            </section>
            {l.segments.length > 0 && <section className={styles.sec}>
                <h3>Segmentações</h3>
                <div className={ui.tags}>{l.segments.map((segment) => <Badge key={segment.id} label={segment.name} variant="info" />)}</div>
            </section>}
            <section className={styles.sec}>
              <h3>Tags</h3>
              {l.tags.length ? <div className={ui.tags}>{l.tags.map((t) => <span key={t} className={ui.tag}>{t}</span>)}</div> : <p className={ui.muted}>Sem tags.</p>}
            </section>
            {Object.keys(l.customFields).length > 0 && (
              <section className={styles.sec}>
                <h3>Campos personalizados</h3>
                <dl className={styles.kv}>
                  {Object.entries(l.customFields).map(([k, v]) => (
                    <div key={k} className={styles.par}><dt>{k.replace(/^cf_/, '')}</dt><dd>{typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}</dd></div>
                  ))}
                </dl>
              </section>
            )}
            <section className={styles.sec}>
              <h3>Atualização e disponibilidade</h3>
              <p>Último detalhe: {formatDate(freshness?.enrichedAt ?? null)}</p>
              <p>Último histórico completo: {formatDate(freshness?.historySyncedAt ?? null)}</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                {sources.map(([key, label]) => <EndpointStatus key={key} label={label} endpoint={coverage?.[key] ?? { status: 'unknown', checkedAt: null, reason: null }} />)}
              </div>
              <h3>Conversões{historyComplete ? ` (${l.conversionsCount})` : ''}</h3>
              <ul className={styles.timeline}>
                {l.events.map((e) => <li key={e.id}><span className={`${ui.muted} ${ui.mono}`}>{dataHora(e.occurredAt)}</span><span>{e.type === 'OPPORTUNITY' ? '★ ' : ''}{e.identifier}</span></li>)}
                {l.events.length === 0 && <li className={ui.muted}>{historyComplete ? 'Nenhum evento encontrado.' : 'Histórico ainda não sincronizado; eventos podem estar incompletos.'}</li>}
              </ul>
            </section>
            <ClassificationPanel leadId={id} />
          </>)}
        </div>
      </div>
    </dialog>
  );
}
