import { Check } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import form from '../../components/form.module.scss';
import { Progress } from '../../components/Progress';
import ui from '../../components/ui.module.scss';
import { ApiError } from '../../lib/apiClient';
import { useRdConnection, useRdMutations, useSegmentations, useSyncRuns } from './rdApi';
import { getSyncProgress } from './syncProgress';
import styles from './ConectarRdPage.module.scss';

const msg = (e: unknown): string => (e instanceof ApiError ? e.message : 'Falhou');
const syncPhases = [
  { phase: 'discovering', label: 'Descoberta', counter: 'contactsDiscovered', text: 'contatos encontrados' },
  { phase: 'importing', label: 'Importação', counter: 'contactsImported', text: 'contatos importados' },
  { phase: 'enriching', label: 'Enriquecimento', counter: 'contactsEnriched', text: 'contatos enriquecidos' },
  { phase: 'history', label: 'Histórico', counter: 'contactsWithHistory', text: 'contatos com histórico' },
] as const;
const syncStatusLabel: Record<string, string> = {
  queued: 'Na fila', running: 'Em andamento', partial: 'Parcial', failed: 'Falhou', completed: 'Concluída', paused: 'Pausada',
};

function Passo({ n, done, titulo, children }: { n: number; done: boolean; titulo: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className={`${styles.step} ${done ? styles.done : ''}`}>
      <div className={styles.n}>{done ? <Check size={15} /> : n}</div>
      <div className={`${ui.card} ${styles.stepCard}`}><strong>{titulo}</strong>{children}</div>
    </div>
  );
}

export function ConectarRdPage(): React.ReactElement {
  const { data: c, isLoading } = useRdConnection();
  const m = useRdMutations();
  const [segmentSearch, setSegmentSearch] = useState('');
  const [clientId, setClientId] = useState(''); const [clientSecret, setClientSecret] = useState('');
  const autorizado = c?.status === 'authorized' || c?.status === 'active';
  const { data: segs, error: segErro } = useSegmentations(autorizado);
  const { data: runPage } = useSyncRuns(Boolean(c));
  const runs = runPage?.items ?? [];
  if (isLoading || !c) return <p className={ui.muted}>Carregando…</p>;

  const callback = `${window.location.origin}/api/rd/callback`;
  const selectedIds = new Set(c.segmentations.map((s) => s.id));
  const syncPermitido = c.status === 'active' || c.status === 'error';
  const visibleSegments = segs?.filter((s) => s.name.toLocaleLowerCase('pt-BR').includes(segmentSearch.trim().toLocaleLowerCase('pt-BR'))) ?? [];
  const toggleSegmentation = (id: string, checked: boolean): void => {
    const ids = new Set(selectedIds);
    if (checked) ids.add(id); else ids.delete(id);
    m.segmentations.mutate({ segmentationIds: [...ids] });
  };
  const runsBySegment = new Map<string, (typeof runs)[number]>();
  for (const run of runs) {
    if (!run.segmentId) continue;
    const current = runsBySegment.get(run.segmentId);
    if (!current || run.startedAt >= current.startedAt) runsBySegment.set(run.segmentId, run);
  }
  const catalogRun = runs.filter((run) => run.kind === 'catalog').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const catalogActive = Boolean(catalogRun?.emAndamento || ['queued', 'running'].includes(catalogRun?.status ?? ''));

  return (
    <div className={ui.page}>
      <h1 className={ui.title}>Conexão com o RD Station Marketing</h1>
      {c.lastError && <div className={ui.alert}>Último erro: {c.lastError}</div>}
      {c.status === 'reauth_required' && <div className={ui.alert}>O RD revogou o acesso. Autorize de novo no passo 2.</div>}
      <div className={styles.steps}>
        <Passo n={1} done={c.hasClientSecret || c.credencialOrigem === 'env'} titulo="Credenciais do app">
          <p className={ui.muted}>Crie um app em <a href="https://appstore.rdstation.com" target="_blank" rel="noreferrer">appstore.rdstation.com</a> com URL de callback <code className={ui.mono}>{callback}</code> e cole aqui.</p>
          {c.credencialOrigem === 'env' && <div className={ui.alert}>Usando as credenciais do servidor (.env). Preencha abaixo para usar credenciais próprias desta conta.</div>}
          <div className={form.field}><label className={form.label} htmlFor="cid">client_id</label><input id="cid" className={form.control} value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={c.clientId ?? ''} /></div>
          <div className={form.field}><label className={form.label} htmlFor="csec">client_secret {c.hasClientSecret && <span className={ui.muted}>(já salvo — preencha só para trocar)</span>}</label><input id="csec" className={form.control} type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></div>
          <button className={ui.btnPrimary} disabled={!clientId || !clientSecret || m.credentials.isPending} onClick={() => m.credentials.mutate({ clientId, clientSecret }, { onSuccess: () => setClientSecret('') })}>Salvar</button>
          {m.credentials.error && <div className={ui.alert} style={{ marginTop: 10 }}>{msg(m.credentials.error)}</div>}
        </Passo>

        <Passo n={2} done={autorizado} titulo="Autorizar no RD">
          <p className={ui.muted}>Abre a tela do RD; entre com um usuário que tenha acesso ao RD Marketing da conta.</p>
          <button className={ui.btnPrimary} disabled={!c.hasClientSecret || m.authorize.isPending} onClick={() => m.authorize.mutate()}>{autorizado ? 'Autorizar de novo' : 'Autorizar'}</button>
        </Passo>

        <Passo n={3} done={c.segmentations.some((s) => s.selected)} titulo="Segmentações monitoradas">
          <p className={ui.muted}>Escolha as segmentações que serão sincronizadas. Leads presentes em mais de uma segmentação serão consolidados.</p>
          {!autorizado ? <p className={ui.muted}>Autorize primeiro.</p> : segErro ? <div className={ui.alert}>{msg(segErro)}</div> : !segs ? <p className={ui.muted}>Carregando segmentações…</p> : (
            <div className={form.field} aria-label="Segmentações disponíveis">
              <input className={form.control} type="search" aria-label="Buscar segmentações" placeholder="Buscar segmentações" value={segmentSearch} onChange={(e) => setSegmentSearch(e.target.value)} />
              {visibleSegments.map((s) => <label key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
                <input type="checkbox" checked={selectedIds.has(s.id)} disabled={(!s.available && !selectedIds.has(s.id)) || m.segmentations.isPending} onChange={(e) => toggleSegmentation(s.id, e.target.checked)} />
                <span>{s.name}{s.standard ? ' (padrão)' : ''}{!s.available ? ' (indisponível no RD)' : ''}</span>
              </label>)}
              {!visibleSegments.length && <p className={ui.muted}>Nenhuma segmentação encontrada.</p>}
            </div>
          )}
          {m.segmentations.error && <div className={ui.alert} role="alert">{msg(m.segmentations.error)}</div>}
          <button className={ui.btnPrimary} disabled={!syncPermitido || m.catalog.isPending || catalogActive} onClick={() => m.catalog.mutate()}>
            {m.catalog.isPending ? 'Enviando…' : catalogActive ? 'Atualização do catálogo na fila' : 'Atualizar catálogo'}
          </button>
          {catalogRun && <p className={catalogRun.status === 'failed' || catalogRun.error ? ui.alert : ui.muted} role={catalogRun.status === 'failed' || catalogRun.error ? 'alert' : 'status'}>
            Catálogo: {catalogRun.status ? syncStatusLabel[catalogRun.status] ?? catalogRun.status : 'Na fila'}{catalogRun.error ? `: ${catalogRun.error}` : ''}
          </p>}
          {m.catalog.error && <div className={ui.alert} style={{ marginTop: 10 }} role="alert">{msg(m.catalog.error)}</div>}
        </Passo>

        <Passo n={4} done={c.segmentations.length > 0 && c.segmentations.every((seg) => runsBySegment.get(seg.id)?.status === 'completed')} titulo="Carga inicial">
          {c.segmentations.length > 0 ? <div aria-label="Status da carga por segmentação">
            {c.segmentations.map((seg) => {
              const run = runsBySegment.get(seg.id);
              const completed = runs.find((item) => item.segmentId === seg.id && item.status === 'completed' && item.finishedAt);
              const counts = run?.stats;
              const status = run?.status ?? (run?.error ? 'failed' : run?.finishedAt ? (counts?.phase === 'completed' ? 'completed' : 'partial') : run ? 'running' : null);
              const active = Boolean(run?.emAndamento || status === 'queued' || status === 'running');
              const progress = getSyncProgress(run);
              const phaseIndex = counts?.phase === 'completed' ? syncPhases.length - 1 : syncPhases.findIndex(({ phase }) => phase === counts?.phase);
              return <div className={form.field} key={seg.id}>
                <strong>{seg.name}</strong>
                {completed?.finishedAt && <p className={ui.muted}>Última conclusão: <time dateTime={completed.finishedAt}>{new Date(completed.finishedAt).toLocaleString('pt-BR')}</time></p>}
                <p className={status === 'failed' ? ui.alert : ui.muted} role={status === 'failed' ? 'alert' : 'status'}>
                  {status ? syncStatusLabel[status] ?? status : 'Aguardando primeira carga'}{run?.error ? `: ${run.error}` : ''}{run?.cursor ? ` · página ${run.cursor}` : ''}
                </p>
                {active && <Progress pct={progress.kind === 'determinate' ? progress.percentage : null} />}
                {run && phaseIndex >= 0 && <ol className={styles.phases} aria-label={`Etapas da carga: ${seg.name}`}>
                  {syncPhases.map(({ phase, label, counter, text }, index) => {
                    const failed = !active && Boolean(run.error) && index === phaseIndex;
                    const finished = !failed && (!active && !run.error || counts?.phase === 'completed' || index < phaseIndex);
                    const current = active && index === phaseIndex;
                    const count = counts?.[counter];
                    return <li key={phase} data-state={failed ? 'failed' : finished ? 'done' : current ? 'current' : 'pending'} aria-current={current || failed ? 'step' : undefined}>
                      <span>{label}</span><span className={ui.muted}>{Number.isFinite(count) ? `${count} ${text}` : 'contagem indisponível'}</span>
                    </li>;
                  })}
                </ol>}
                {run && <p className={ui.muted}>{counts?.contactsDiscovered != null ? `${counts.contactsDiscovered} contatos encontrados · ` : ''}{counts?.contactsImported != null ? `${counts.contactsImported} importados · ` : `${counts?.lidos ?? 0} lidos · `}{counts?.contactsEnriched != null ? `${counts.contactsEnriched} enriquecidos · ` : ''}{counts?.contactsWithHistory != null ? `${counts.contactsWithHistory} com histórico · ` : ''}{counts?.contactsFailed != null ? `${counts.contactsFailed} falhas` : `${counts?.erros ?? 0} erros`}</p>}
                {counts?.primeiroErro && <p className={ui.alert}>Primeiro erro: {counts.primeiroErro}</p>}
              </div>;
            })}
          </div> : <p className={ui.muted}>Selecione ao menos uma segmentação antes da carga.</p>}
          <button className={ui.btnPrimary} disabled={!syncPermitido || !c.segmentations.length || m.sync.isPending} onClick={() => m.sync.mutate()}>{runs.some((run) => run.status === 'completed') ? 'Sincronizar segmentações' : 'Iniciar carga'}</button>
          {m.sync.error && <div className={ui.alert} style={{ marginTop: 10 }} role="alert">{msg(m.sync.error)}</div>}
          {(c.lastFullSyncAt || runs.some((run) => run.status === 'completed')) && <p style={{ marginBottom: 0 }}><Link to="/leads">Ver leads →</Link></p>}
        </Passo>
      </div>
    </div>
  );
}
