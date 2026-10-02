import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { RdConnectionView, RdCredentialsDto, RdSegmentation, RdSegmentationDto, RdSegmentationSelectionDto, SyncRunPage, SyncRunView } from '@rd/shared';
import { api } from '../../lib/apiClient';

export const useRdConnection = () => useQuery({ queryKey: ['rd', 'connection'], queryFn: () => api.get<RdConnectionView>('/rd/connection') });
export const useSegmentations = (enabled: boolean) => useQuery({ queryKey: ['rd', 'segmentations'], queryFn: () => api.get<RdSegmentation[]>('/rd/segmentations'), enabled, retry: 0 });
export const useSyncRuns = (ativo: boolean) => {
  const qc = useQueryClient();
  const wasCatalogActive = useRef(false);
  const query = useQuery({ queryKey: ['rd', 'sync', 'runs', { pageSize: 100 }], queryFn: () => api.get<SyncRunPage>('/rd/sync/runs?pageSize=100'), refetchInterval: (q) => (ativo && q.state.data?.items.some((run) => run.emAndamento || ['queued', 'running'].includes(run.status ?? '')) ? 2000 : false) });
  const catalogActive = Boolean(query.data?.items.some((run) => run.kind === 'catalog' && (run.emAndamento || ['queued', 'running'].includes(run.status ?? ''))));
  useEffect(() => {
    if (wasCatalogActive.current && !catalogActive) void qc.invalidateQueries({ queryKey: ['rd', 'segmentations'] });
    wasCatalogActive.current = catalogActive;
  }, [catalogActive, qc]);
  return query;
};
export const useSyncStatus = (ativo: boolean) => useQuery({ queryKey: ['rd', 'sync'], queryFn: () => api.get<SyncRunView | null>('/rd/sync/status'), refetchInterval: (q) => (ativo && q.state.data?.emAndamento ? 2000 : false) });
export function useRdMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ['rd'] });
  return {
    credentials: useMutation({ mutationFn: (d: RdCredentialsDto) => api.post<RdConnectionView>('/rd/credentials', d), onSuccess: inv }),
    authorize: useMutation({ mutationFn: () => api.get<{ url: string }>('/rd/authorize-url'), onSuccess: ({ url }) => { window.location.href = url; } }),
    segmentation: useMutation({ mutationFn: (d: RdSegmentationDto) => api.post<RdConnectionView>('/rd/segmentation', d), onSuccess: inv }),
    segmentations: useMutation({ mutationFn: (d: RdSegmentationSelectionDto) => api.post<RdConnectionView>('/rd/segmentations/selection', d), onSuccess: inv }),
    sync: useMutation({ mutationFn: () => api.post<{ runIds: string[]; runId?: string }>('/rd/sync'), onSuccess: inv }),
    catalog: useMutation({ mutationFn: () => api.post<{ runId: string; runIds: string[] }>('/rd/sync/catalog'), onSuccess: inv }),
  };
}
