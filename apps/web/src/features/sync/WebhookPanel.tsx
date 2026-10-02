import ui from '../../components/ui.module.scss';
import { useAuth } from '../../auth/AuthContext';
import { useRegisterWebhooks, useRetryWebhook, useWebhookStatus } from './syncApi';

const timeZone = 'America/Sao_Paulo';
const eventLabels: Record<string, string> = { 'WEBHOOK.CONVERTED': 'Conversão', 'WEBHOOK.MARKED_OPPORTUNITY': 'Oportunidade' };

function date(value: string | null): string {
  return value ? new Date(value).toLocaleString('pt-BR', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'Não registrada';
}

function eventLabel(eventType: string): string {
  return eventLabels[eventType] ?? 'Evento RD';
}

export function WebhookPanel(): React.ReactElement {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const query = useWebhookStatus();
  const register = useRegisterWebhooks();
  const retry = useRetryWebhook();
  const view = query.data;

  return <section aria-labelledby="webhook-heading" style={{ marginBottom: 28 }}>
    <h2 id="webhook-heading">Eventos em tempo real</h2>
    <p className={ui.muted}>Os eventos recebidos não confirmam atualização completa nem cobertura dos dados. O RD não envia mudanças feitas manualmente na plataforma.</p>
    {query.isLoading && <p role="status">Carregando eventos do RD…</p>}
    {query.error && <p className={ui.alert} role="alert">Não foi possível carregar os eventos do RD.</p>}
    {!query.isLoading && !query.error && !view && <p className={ui.alert} role="alert">Eventos do RD indisponíveis.</p>}
    {view && <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12, marginBottom: 16 }}>
        <article className={ui.card} style={{ minWidth: 0 }}>
          <strong>Processamento</strong>
          <p>{view.worker === 'running' ? 'Disponível' : 'Indisponível'}</p>
        </article>
        <article className={ui.card} style={{ minWidth: 0 }}>
          <strong>Fila de eventos</strong>
          <p>{view.pending} pendentes · {view.failed} com falha</p>
        </article>
        <article className={ui.card} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          <strong>Recebimento do RD</strong>
          <p><strong>{view.configured ? 'Tempo real ativo' : 'Tempo real inativo'}</strong></p>
          <p>Última verificação: <time dateTime={view.registeredAt ?? undefined}>{date(view.registeredAt)}</time></p>
          {view.registrationError && <p className={ui.alert} role="alert">Não foi possível verificar o recebimento dos eventos do RD.</p>}
        </article>
      </div>
      <p>Último evento recebido: <time dateTime={view.lastReceivedAt ?? undefined}>{date(view.lastReceivedAt)}</time></p>
      <p>Último evento processado: <time dateTime={view.lastProcessedAt ?? undefined}>{date(view.lastProcessedAt)}</time></p>
      <h3>Eventos com falha</h3>
      {!view.failures.length && <p className={ui.muted}>Nenhum evento com falha.</p>}
      {!!view.failures.length && <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
        {view.failures.map((failure) => <article className={ui.card} key={failure.id} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          <strong>{eventLabel(failure.eventType)}</strong>
          <p>Recebido em <time dateTime={failure.receivedAt}>{date(failure.receivedAt)}</time> · {failure.attempts} tentativas</p>
          {admin && <button className={ui.btnPrimary} disabled={retry.isPending} onClick={() => retry.mutate(failure.id)}>Tentar novamente</button>}
        </article>)}
      </div>}
      {admin ? <button className={ui.btnPrimary} disabled={register.isPending} onClick={() => register.mutate()}>{register.isPending ? 'Ativando…' : view.configured ? 'Verificar tempo real' : 'Ativar tempo real'}</button> : <p className={ui.muted}>Somente leitura</p>}
      {register.error && <p className={ui.alert} role="alert">Não foi possível configurar o recebimento dos eventos do RD.</p>}
      {register.isSuccess && <p className={ui.muted} role="status">Verificação solicitada.</p>}
      {retry.error && <p className={ui.alert} role="alert">Não foi possível tentar novamente o evento.</p>}
      {retry.isSuccess && <p className={ui.muted} role="status">Nova tentativa solicitada; o evento ainda não foi processado.</p>}
    </>}
  </section>;
}
