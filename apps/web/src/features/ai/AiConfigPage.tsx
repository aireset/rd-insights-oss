import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/apiClient';
import form from '../../components/form.module.scss';
import ui from '../../components/ui.module.scss';

type Provider = 'openai-compatible' | 'omniroute';
interface AiConfig { provider: Provider; baseUrl: string; model: string; enabled: boolean; monthlyBudgetCents: number; requestsPerMinute: number; hasApiKey: boolean }
interface AiConfigForm extends Omit<AiConfig, 'hasApiKey'> { apiKey: string }
const empty: AiConfigForm = { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: '', enabled: false, monthlyBudgetCents: 1000, requestsPerMinute: 10, apiKey: '' };

export function AiConfigPage(): React.ReactElement {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['ai-config'], queryFn: () => api.get<AiConfig>('/ai/config') });
  const [draft, setDraft] = useState<AiConfigForm | null>(null);
  const value = draft ?? (query.data ? { ...query.data, apiKey: '' } : empty);
  const save = useMutation({
    mutationFn: (config: AiConfigForm) => api.put<AiConfig>('/ai/config', config),
    onSuccess: async () => { setDraft(null); await client.invalidateQueries({ queryKey: ['ai-config'] }); },
  });
  const update = <K extends keyof AiConfigForm>(key: K, next: AiConfigForm[K]) => setDraft({ ...value, [key]: next });

  return <>
    <h1 className={ui.title}>Configuração de IA</h1>
    <p className={ui.muted}>Configure um provider compatível com a API OpenAI, incluindo OmniRoute. A chave fica cifrada no servidor e nunca é exibida novamente.</p>
    {query.isLoading && <p role="status" className={ui.muted}>Carregando configuração…</p>}
    {query.error && <p className={ui.alert} role="alert">Não foi possível carregar a configuração: {query.error.message}</p>}
    <form className={ui.card} style={{ maxWidth: 680 }} onSubmit={(event) => { event.preventDefault(); save.mutate(value); }}>
      <label className={form.field}><span className={form.label}>Provider</span><select className={form.control} value={value.provider} onChange={(event) => update('provider', event.target.value as Provider)}><option value="openai-compatible">OpenAI-compatible</option><option value="omniroute">OmniRoute</option></select></label>
      <label className={form.field}><span className={form.label}>URL base HTTPS pública</span><input className={form.control} type="url" required value={value.baseUrl} onChange={(event) => update('baseUrl', event.target.value)} autoComplete="url" /><small className={form.hint}>Endereços locais e privados são bloqueados.</small></label>
      <label className={form.field}><span className={form.label}>Modelo</span><input className={form.control} required maxLength={120} value={value.model} onChange={(event) => update('model', event.target.value)} /></label>
      <label className={form.field}><span className={form.label}>Chave da API {query.data?.hasApiKey ? '(salva; em branco mantém a atual)' : ''}</span><input className={form.control} type="password" autoComplete="new-password" maxLength={500} value={value.apiKey} onChange={(event) => update('apiKey', event.target.value)} required={!query.data?.hasApiKey} /></label>
      <label className={form.field}><span className={form.label}>Limite mensal (centavos)</span><input className={form.control} type="number" min={1} max={100_000_000} required value={value.monthlyBudgetCents} onChange={(event) => update('monthlyBudgetCents', Number(event.target.value))} /></label>
      <label className={form.field}><span className={form.label}>Requisições máximas por minuto</span><input className={form.control} type="number" min={1} max={600} required value={value.requestsPerMinute} onChange={(event) => update('requestsPerMinute', Number(event.target.value))} /></label>
      <label className={form.field}><input type="checkbox" checked={value.enabled} onChange={(event) => update('enabled', event.target.checked)} /> Habilitar provider</label>
      {save.error && <p className={ui.alert} role="alert">Não foi possível salvar: {save.error.message}</p>}
      {save.isSuccess && <p className={ui.muted} role="status">Configuração salva. A chave não foi retornada pelo servidor.</p>}
      <button className={form.save} type="submit" disabled={save.isPending || query.isLoading || !!query.error}>{save.isPending ? 'Salvando…' : 'Salvar configuração'}</button>
    </form>
  </>;
}
