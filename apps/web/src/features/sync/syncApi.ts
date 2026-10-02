import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DailySyncView, ReconciliationScheduleView, SegmentCoverageView, SyncRunPage, SyncRunsQuery, WebhookStatusView } from '@rd/shared';
import { api } from '../../lib/apiClient';

export const useReconciliationSchedule = () => useQuery({
  queryKey: ['rd', 'sync', 'schedule'],
  queryFn: () => api.get<ReconciliationScheduleView>('/rd/sync/schedule'),
  refetchInterval: 5_000,
});

export const useReconciliationRuns = (filters: Partial<SyncRunsQuery> = {}) => useQuery({
  queryKey: ['rd', 'sync', 'runs', filters],
  queryFn: () => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== undefined) query.set(key, String(value));
    return api.get<SyncRunPage>(`/rd/sync/runs?${query}`);
  },
  refetchInterval: 5_000,
});

export const useSegmentCoverage = () => useQuery({
  queryKey: ['rd', 'sync', 'coverage'],
  queryFn: () => api.get<SegmentCoverageView[]>('/rd/sync/coverage'),
  refetchInterval: 5_000,
});

export const useDailySync = () => useQuery({
  queryKey: ['rd', 'sync', 'daily'],
  queryFn: () => api.get<DailySyncView>('/rd/sync/daily'),
  refetchInterval: 5_000,
});

export const useWebhookStatus = () => useQuery({
  queryKey: ['rd', 'webhooks', 'status'],
  queryFn: () => api.get<WebhookStatusView>('/rd/webhooks/status'),
  refetchInterval: 5_000,
});

export const useRegisterWebhooks = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/rd/webhooks/register'),
    onSuccess: () => client.invalidateQueries({ queryKey: ['rd', 'webhooks', 'status'] }),
  });
};

export const useRetryWebhook = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/rd/webhooks/retry/${encodeURIComponent(id)}`),
    onSuccess: () => client.invalidateQueries({ queryKey: ['rd', 'webhooks', 'status'] }),
  });
};

export const useRefreshNow = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/rd/sync/refresh'),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['rd', 'sync', 'daily'] }),
        client.invalidateQueries({ queryKey: ['rd', 'sync', 'runs'] }),
      ]);
    },
  });
};

export const useUpdateRefreshBudget = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (dailyBudget: number) => api.post('/rd/sync/refresh/budget', { dailyBudget }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['rd', 'sync', 'daily'] }),
  });
};

export const useReconcileNow = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/rd/sync/reconcile'),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['rd', 'sync', 'schedule'] }),
        client.invalidateQueries({ queryKey: ['rd', 'sync', 'runs'] }),
      ]);
    },
  });
};
