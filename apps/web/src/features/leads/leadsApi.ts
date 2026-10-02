import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LeadDetail, LeadFacets, LeadRow, LeadsQuery, Page, SavedViewInput, SavedViewView } from '@rd/shared';
import { api } from '../../lib/apiClient';
import { toSearch } from './filtros';

export const useLeads = (q: LeadsQuery) => useQuery({ queryKey: ['leads', q], queryFn: () => api.get<Page<LeadRow>>(`/leads?${toSearch(q)}`), placeholderData: (prev) => prev });
export const useFacets = (q: LeadsQuery) => useQuery({ queryKey: ['leads', 'facets', q], queryFn: () => api.get<LeadFacets>(`/leads/facets?${toSearch(q)}`), staleTime: 5 * 60_000 });
export const useLead = (id: string) => useQuery({ queryKey: ['lead', id], queryFn: () => api.get<LeadDetail>(`/leads/${id}`) });
export const useSavedViews = () => useQuery({ queryKey: ['leads', 'saved-views'], queryFn: () => api.get<SavedViewView[]>('/leads/saved-views') });
export function useSaveView() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: SavedViewInput) => api.post<SavedViewView>('/leads/saved-views', input), onSuccess: () => client.invalidateQueries({ queryKey: ['leads', 'saved-views'] }) });
}
export function useDeleteSavedView() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.delete(`/leads/saved-views/${id}`), onSuccess: () => client.invalidateQueries({ queryKey: ['leads', 'saved-views'] }) });
}

export async function exportLeads(q: LeadsQuery): Promise<void> {
  const browser = window as Window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable: () => Promise<WritableStream<Uint8Array>> }> };
  const file = browser.showSaveFilePicker ? await browser.showSaveFilePicker({ suggestedName: 'leads.csv' }) : undefined;
  const response = await api.stream(`/leads/export.csv?${toSearch(q)}`);
  if (file && response.body) {
    await response.body.pipeTo(await file.createWritable());
    return;
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = 'leads.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
