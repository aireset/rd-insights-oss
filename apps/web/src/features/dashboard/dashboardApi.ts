import { useQuery } from '@tanstack/react-query';
import type { DashboardSummaryView } from '@rd/shared';
import { api } from '../../lib/apiClient';

export interface NewLeadsPoint { date: string; count: number }
export interface NewLeadsDashboard { period: 7 | 30 | 90; timeZone: string; total: number; points: NewLeadsPoint[] }
export interface NewLeadsQuery { period: 7 | 30 | 90; segmentIds?: string[]; segmentMatch: 'any' | 'all' }
export interface SegmentComparison { a: number; b: number; overlap: number; union: number }
export interface RdAnalyticsMetric { asset_id: number; asset_identifier: string; asset_type: string; visits_count: number; conversions_count: number; conversion_rate: number }
export interface RdAnalyticsCache { data: { conversions?: RdAnalyticsMetric[] } | Record<string, unknown> | null; fetchedAt: string | null; error: string | null; stale: boolean; period: number; scope: 'global' }
export interface RdAnalyticsDashboard { conversions: RdAnalyticsCache; funnel: RdAnalyticsCache }
export interface DailyInsightSnapshot { id: string; scope: { type: 'base' } | { type: 'segment'; id: string; name: string }; snapshotDate: string; timezone: string; contextText: string; bullets: string[] | null; error: string | null; model: string | null }

export function useDailyInsights(segmentIds: string[]) {
  const params = new URLSearchParams();
  if (segmentIds.length) params.set('segmentIds', segmentIds.join(','));
  const query = params.toString();
  return useQuery({ queryKey: ['dashboard', 'daily-insights', segmentIds], queryFn: () => api.get<DailyInsightSnapshot[]>(`/ai/daily-insights${query ? `?${query}` : ''}`), staleTime: 5 * 60_000 });
}

export function useRdAnalytics() {
  return useQuery({ queryKey: ['dashboard', 'rd-analytics'], queryFn: () => api.get<RdAnalyticsDashboard>('/dashboard/analytics'), staleTime: 5 * 60_000 });
}

export function useNewLeads(query: NewLeadsQuery) {
  const params = new URLSearchParams({ period: String(query.period), segmentMatch: query.segmentMatch });
  if (query.segmentIds?.length) params.set('segmentIds', query.segmentIds.join(','));
  return useQuery({ queryKey: ['dashboard', 'new-leads', query], queryFn: () => api.get<NewLeadsDashboard>(`/dashboard/new-leads?${params}`), staleTime: 5 * 60_000 });
}

export function useDashboardSummary(query: NewLeadsQuery) {
  const params = new URLSearchParams({ period: String(query.period), segmentMatch: query.segmentMatch });
  if (query.segmentIds?.length) params.set('segmentIds', query.segmentIds.join(','));
  return useQuery({ queryKey: ['dashboard', 'summary', query], queryFn: () => api.get<DashboardSummaryView>(`/dashboard/summary?${params}`), staleTime: 5 * 60_000 });
}

export function useSegmentComparison(segmentAId: string, segmentBId: string) {
  const params = new URLSearchParams({ segmentAId, segmentBId });
  return useQuery({
    queryKey: ['dashboard', 'segment-comparison', segmentAId, segmentBId],
    queryFn: () => api.get<SegmentComparison>(`/dashboard/segment-comparison?${params}`),
    enabled: Boolean(segmentAId && segmentBId),
    staleTime: 5 * 60_000,
  });
}

export interface AiDistribution { configured: boolean; total: number; quente: number; morno: number; frio: number; semClassificacao: number; pending: number; failed: number }
export function useAiDistribution() {
  return useQuery({ queryKey: ['dashboard', 'ai-distribution'], queryFn: () => api.get<AiDistribution>('/ai/classification/distribution'), staleTime: 60_000, refetchInterval: 30_000 });
}
