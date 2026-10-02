import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, SlidersHorizontal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { LeadsQuery } from '@rd/shared';
import { LEAD_SORTS, LEADS_DATE_TIME_ZONE } from '@rd/shared';
import { Badge } from '../../components/Badge';
import { ChipFiltro } from '../../components/ChipFiltro';
import form from '../../components/form.module.scss';
import ui from '../../components/ui.module.scss';
import { dataHora } from '../../lib/format';
import { useRdConnection } from '../onboarding/rdApi';
import { fromSearch, toSearch } from './filtros';
import { LeadModal } from './LeadModal';
import { exportLeads, useDeleteSavedView, useFacets, useLeads, useSaveView, useSavedViews } from './leadsApi';

type Sort = (typeof LEAD_SORTS)[number];
const ORDENS: Array<{ s: Sort; label: string }> = [
  { s: 'lastConversionAt', label: 'Última alteração' },
  { s: 'firstConversionAt', label: 'Data de entrada' },
  { s: 'name', label: 'Nome' },
  { s: 'conversionsCount', label: 'Conversões' },
  { s: 'lifecycleStage', label: 'Estágio' },
];

export function LeadsPage(): React.ReactElement {
  const [sp, setSp] = useSearchParams();
  const q = useMemo(() => fromSearch(sp), [sp]);
  const leadId = sp.get('lead');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);
  const [viewName, setViewName] = useState('');
  const [viewId, setViewId] = useState('');
  const { data, error, isFetching } = useLeads(q);
  const { data: facets } = useFacets(q);
  const { data: savedViews = [] } = useSavedViews();
  const saveView = useSaveView();
  const deleteView = useDeleteSavedView();
  const { data: connection } = useRdConnection();
  const activeSegments = connection?.segmentations.filter((s) => s.selected && s.available) ?? [];
  const [abertos, setAbertos] = useState(false);
  const set = (patch: Partial<LeadsQuery>) => setSp(toSearch({ ...q, page: 1, ...patch }));
  const toggleSegment = (id: string, checked: boolean) => {
    const ids = new Set(q.segmentIds ?? []);
    if (checked) ids.add(id); else ids.delete(id);
    set({ segmentIds: ids.size ? [...ids] : undefined });
  };
  const sortBy = (s: Sort) => set({ sort: s, dir: q.sort === s && q.dir === 'desc' ? 'asc' : 'desc' });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const download = async () => {
    setExporting(true);
    try { await exportLeads(q); setExportError(false); }
    catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setExportError(true); }
    finally { setExporting(false); }
  };
  const applyView = (id: string) => {
    setViewId(id);
    const view = savedViews.find((item) => item.id === id);
    if (view) setSp(toSearch(view.filters as Partial<LeadsQuery>));
  };
  const saveCurrentView = () => {
    const filters = Object.fromEntries(Object.entries(q).filter(([key]) => key !== 'page' && key !== 'pageSize')) as Omit<LeadsQuery, 'page' | 'pageSize'>;
    saveView.mutate({ name: viewName, filters }, { onSuccess: (view) => { setViewId(view.id); setViewName(''); } });
  };
  const abrir = (id: string) => { const n = new URLSearchParams(sp); n.set('lead', id); setSp(n); };
  const fechar = () => { const n = new URLSearchParams(sp); n.delete('lead'); setSp(n, { replace: true }); };

  const ativos: Array<{ label: string; limpar: () => void }> = [];
  if (q.lifecycleStage?.[0]) ativos.push({ label: `Estágio: ${q.lifecycleStage[0]}`, limpar: () => set({ lifecycleStage: undefined }) });
  if (q.tags?.[0]) ativos.push({ label: `Tag: ${q.tags[0]}`, limpar: () => set({ tags: undefined }) });
  if (q.conversao) ativos.push({ label: `Conversão: ${q.conversao}`, limpar: () => set({ conversao: undefined }) });
  if (q.oportunidade !== undefined) ativos.push({ label: `Oportunidade: ${q.oportunidade ? 'sim' : 'não'}`, limpar: () => set({ oportunidade: undefined }) });
  if (q.de) ativos.push({ label: `Desde ${q.de.toISOString().slice(0, 10).split('-').reverse().join('/')}`, limpar: () => set({ de: undefined }) });
  if (q.ate) ativos.push({ label: `Até ${q.ate.toISOString().slice(0, 10).split('-').reverse().join('/')}`, limpar: () => set({ ate: undefined }) });
  if (q.cidade) ativos.push({ label: `Cidade: ${q.cidade}`, limpar: () => set({ cidade: undefined }) });
  if (q.uf) ativos.push({ label: `UF: ${q.uf}`, limpar: () => set({ uf: undefined }) });
  if (q.aiScore) ativos.push({ label: `IA: ${q.aiScore}`, limpar: () => set({ aiScore: undefined }) });
  if (q.segmentIds?.length) ativos.push({ label: `${q.segmentIds.length} segmentação(ões)`, limpar: () => set({ segmentIds: undefined }) });

  return (
    <div className={ui.page}>
      <h1 className={ui.title}>Leads {data && <span className={ui.titleCount}>· {data.total.toLocaleString('pt-BR')}</span>}</h1>

      <div className={ui.toolbar}>
        <input className={`${form.control} ${ui.busca}`} placeholder="Buscar nome, e-mail, telefone, empresa" defaultValue={q.q ?? ''} onKeyDown={(e) => { if (e.key === 'Enter') set({ q: (e.target as HTMLInputElement).value || undefined }); }} />
        <button type="button" className={`${ui.btnSecondary} ${ui.toggle}`} aria-expanded={abertos} onClick={() => setAbertos(!abertos)}>
          <SlidersHorizontal size={16} /> Filtros {ativos.length > 0 && <span className={ui.toggleBadge}>{ativos.length}</span>} {abertos ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {isFetching && <span className={ui.muted}>atualizando…</span>}
      </div>

      {abertos && (
        <div className={ui.filtros}>
          <label className={ui.filtroCampo}><span className={ui.filtroRotulo}>Estágio</span>
            <select className={form.control} value={q.lifecycleStage?.[0] ?? ''} onChange={(e) => set({ lifecycleStage: e.target.value ? [e.target.value] : undefined })}>
              <option value="">Todos</option>{facets?.lifecycleStages.map((s) => <option key={s.value} value={s.value}>{s.value} ({s.count})</option>)}
            </select></label>
          <label className={ui.filtroCampo}><span className={ui.filtroRotulo}>Tag</span>
            <select className={form.control} value={q.tags?.[0] ?? ''} onChange={(e) => set({ tags: e.target.value ? [e.target.value] : undefined })}>
              <option value="">Todas</option>{facets?.tags.map((t) => <option key={t.value} value={t.value}>{t.value} ({t.count})</option>)}
            </select></label>
          <label className={ui.filtroCampo}><span className={ui.filtroRotulo}>Conversão</span>
            <select className={form.control} value={q.conversao ?? ''} onChange={(e) => set({ conversao: e.target.value || undefined })}>
              <option value="">Todas</option>{facets?.conversoes.map((c) => <option key={c.value} value={c.value}>{c.value} ({c.count})</option>)}
            </select></label>
          <label className={ui.filtroCampo}><span className={ui.filtroRotulo}>Oportunidade</span>
            <select className={form.control} value={q.oportunidade === undefined ? '' : String(q.oportunidade)} onChange={(e) => set({ oportunidade: e.target.value === '' ? undefined : e.target.value === 'true' })}>
              <option value="">Todos</option><option value="true">Sim</option><option value="false">Não</option>
            </select></label>
          <label className={ui.filtroCampo}><span className={ui.filtroRotulo}>Última conversão desde</span>
            <input className={form.control} type="date" value={q.de ? q.de.toISOString().slice(0, 10) : ''} onChange={(e) => set({ de: e.target.value ? new Date(e.target.value) : undefined })} /></label>
          <label className={ui.filtroCampo}><span className={ui.filtroRotulo}>Última conversão até</span>
            <input className={form.control} type="date" value={q.ate ? q.ate.toISOString().slice(0, 10) : ''} onChange={(e) => set({ ate: e.target.value ? new Date(e.target.value) : undefined })} /></label>
          <label className={ui.filtroCampo}><span className={ui.filtroRotulo}>Cidade</span>
            <input className={form.control} value={q.cidade ?? ''} onChange={(e) => set({ cidade: e.target.value || undefined })} /></label>
          <label className={ui.filtroCampo}><span className={ui.filtroRotulo}>UF</span>
            <input className={form.control} maxLength={2} value={q.uf ?? ''} onChange={(e) => set({ uf: e.target.value.toUpperCase() || undefined })} /></label>
          <label className={ui.filtroCampo}><span className={ui.filtroRotulo}>Classificação IA</span>
            <select className={form.control} value={q.aiScore ?? ''} onChange={(e) => set({ aiScore: e.target.value ? e.target.value as NonNullable<LeadsQuery['aiScore']> : undefined })}>
              <option value="">Todas</option><option value="quente">Quente</option><option value="morno">Morno</option><option value="frio">Frio</option>
            </select></label>
          <label className={ui.filtroCampo}><span className={ui.filtroRotulo}>Correspondência de segmentos</span>
            <select className={form.control} value={q.segmentMatch ?? 'any'} onChange={(e) => set({ segmentMatch: e.target.value as LeadsQuery['segmentMatch'] })}>
              <option value="any">Em qualquer segmento</option><option value="all">Em todos os segmentos</option>
            </select></label>
          <fieldset className={ui.filtroCampo}>
            <legend className={ui.filtroRotulo}>Segmentações</legend>
            {activeSegments.map((segment) => <label key={segment.id}>
              <input type="checkbox" aria-label={segment.name} checked={q.segmentIds?.includes(segment.id) ?? false} onChange={(e) => toggleSegment(segment.id, e.target.checked)} /> {segment.name}
            </label>)}
            {!activeSegments.length && <span className={ui.muted}>Nenhuma ativa</span>}
          </fieldset>
          {(q.de || q.ate) && <span className={ui.muted}>Datas no fuso {LEADS_DATE_TIME_ZONE}</span>}
          <div className={ui.toolbar} style={{ gridColumn: '1 / -1' }}>
            <button type="button" className={ui.btnPrimary} onClick={() => void download()} disabled={exporting}>{exporting ? 'Preparando CSV…' : 'Exportar CSV'}</button>
            <select className={form.control} aria-label="Visões salvas" value={viewId} onChange={(e) => applyView(e.target.value)}>
              <option value="">Visões salvas…</option>{savedViews.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
            </select>
            <input className={form.control} aria-label="Nome da visão" placeholder="Nome da visão" maxLength={80} value={viewName} onChange={(e) => setViewName(e.target.value)} />
            <button type="button" className={ui.btnPrimary} onClick={saveCurrentView} disabled={!viewName.trim() || saveView.isPending}>Salvar visão</button>
            {viewId && <button type="button" className={ui.btnSecondary} onClick={() => deleteView.mutate(viewId, { onSuccess: () => setViewId('') })} disabled={deleteView.isPending}>Excluir visão</button>}
          </div>
          {exportError && <div className={ui.alert} role="alert" style={{ gridColumn: '1 / -1' }}>Não foi possível exportar os leads filtrados.</div>}
          {(saveView.isError || deleteView.isError) && <div className={ui.alert} role="alert" style={{ gridColumn: '1 / -1' }}>Não foi possível salvar a visão.</div>}
        </div>
      )}

      {error && <div className={ui.alert} role="alert">{error instanceof Error ? error.message : 'Falha ao carregar leads.'}
        {!!q.segmentIds?.length && <button type="button" className={ui.btnSecondary} onClick={() => set({ segmentIds: undefined })}>Limpar filtro de segmentação</button>}
      </div>}

      {ativos.length > 0 && (
        <div>{ativos.map((a) => <ChipFiltro key={a.label} label={a.label} clearLabel={`Limpar ${a.label}`} onClear={a.limpar} />)}
          <button type="button" className={ui.ordemBtn} onClick={() => setSp('')}>Limpar tudo</button></div>
      )}

      <div className={ui.ordem}>
        <span>Ordenar por</span>
        {ORDENS.map(({ s, label }) => (
          <button key={s} type="button" className={ui.ordemBtn} aria-pressed={q.sort === s} onClick={() => sortBy(s)}>
            {label} {q.sort === s && (q.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
          </button>
        ))}
      </div>

      <div className={ui.lista}>
        {data?.items.map((l) => (
          <button key={l.id} type="button" className={ui.linha} onClick={() => abrir(l.id)}>
            <span className={ui.linhaTitulo}>
              <span className={ui.linhaNome}>{l.name ?? <span className={ui.muted}>(sem nome)</span>}
                {l.lifecycleStage && <Badge label={l.lifecycleStage} variant="info" />}
                {l.opportunity && <Badge label="oportunidade" variant="success" />}
                {l.aiScore === 'quente' && <Badge label="🔥 quente" variant="danger" />}
                {l.aiScore === 'morno' && <Badge label="morno" variant="warning" />}
                {l.aiScore === 'frio' && <Badge label="frio" variant="info" />}</span>
              <span className={ui.linhaSub}>{l.email ?? '—'}{[l.city, l.state].filter(Boolean).length > 0 && ` · ${[l.city, l.state].filter(Boolean).join(' / ')}`}</span>
              {l.segments.length > 0 && <span className={ui.tags}>{l.segments.map((segment) => <Badge key={segment.id} label={segment.name} variant="info" />)}</span>}
            </span>
            <span className={ui.linhaMeta}>
              <span className={ui.metaItem}><span className={ui.metaLabel}>Data de entrada</span>{dataHora(l.rdCreatedAt ?? l.firstConversionAt)}</span>
              <span className={ui.metaItem}><span className={ui.metaLabel}>Última alteração</span>{dataHora(l.lastConversionAt)}</span>
              <span className={ui.metaItem}><span className={ui.metaLabel}>Conversões</span>{l.conversionsCount}</span>
            </span>
            {l.tags.length > 0 && <span className={ui.tags}>{l.tags.map((t) => <span key={t} className={ui.tag}>{t}</span>)}</span>}
          </button>
        ))}
        {data && data.items.length === 0 && <div className={ui.vazio}>Nenhum lead com esses filtros.</div>}
      </div>

      <div className={ui.pager}>
        <span>Página {q.page} de {pages}</span>
        <span className={ui.pagBtns}>
          <button className={ui.btnSecondary} disabled={q.page <= 1} onClick={() => setSp(toSearch({ ...q, page: q.page - 1 }))} aria-label="Página anterior">‹</button>
          <button className={ui.btnSecondary} disabled={q.page >= pages} onClick={() => setSp(toSearch({ ...q, page: q.page + 1 }))} aria-label="Próxima página">›</button>
        </span>
      </div>

      {leadId && <LeadModal id={leadId} onClose={fechar} />}
    </div>
  );
}
