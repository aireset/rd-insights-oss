import { z } from 'zod';

export const rdCredentialsSchema = z.object({
  clientId: z.string().trim().min(8).max(200),
  clientSecret: z.string().trim().min(8).max(200),
});
export type RdCredentialsDto = z.infer<typeof rdCredentialsSchema>;

export const rdSegmentationSchema = z.object({ segmentationId: z.string().trim().min(1), segmentationName: z.string().trim().min(1).max(200) });
export type RdSegmentationDto = z.infer<typeof rdSegmentationSchema>;
export const rdSegmentationSelectionSchema = z.object({ segmentationIds: z.array(z.string().trim().min(1).max(200)).refine((ids) => new Set(ids).size === ids.length, 'Segmentações duplicadas') });
export type RdSegmentationSelectionDto = z.infer<typeof rdSegmentationSelectionSchema>;

export type RdConnectionStatus = 'pending' | 'authorized' | 'active' | 'reauth_required' | 'error';
export type RdMembershipCoverage = 'unknown' | 'partial' | 'complete';
export interface RdConnectionView {
  status: RdConnectionStatus; hasClientSecret: boolean; clientId: string | null;
  credencialOrigem: 'painel' | 'env' | null;
  segmentationId: string | null; segmentationName: string | null; segmentations: RdSegmentation[];
  lastFullSyncAt: string | null; lastError: string | null;
}
export interface RdSegmentation { id: string; name: string; standard: boolean; selected: boolean; available: boolean; coverage: RdMembershipCoverage }
export type SyncPhase = 'discovering' | 'importing' | 'enriching' | 'history' | 'completed';
export interface SyncRunStats {
  lidos: number; criados: number; atualizados: number; erros: number; totalPaginas?: number;
  primeiroErro?: string; phase?: SyncPhase; contactsDiscovered?: number; contactsImported?: number; contactsEnriched?: number; contactsWithHistory?: number; contactsFailed?: number;
}
export interface SyncRunView { id: string; segmentId?: string | null; status?: 'queued' | 'running' | 'partial' | 'failed' | 'completed' | 'paused'; kind: string; startedAt: string; finishedAt: string | null; cursor: number; stats: SyncRunStats; error: string | null; emAndamento: boolean }
export const syncRunsQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(200).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  segmentId: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['queued', 'running', 'partial', 'failed', 'completed', 'paused']).optional(),
});
export type SyncRunsQuery = z.infer<typeof syncRunsQuerySchema>;
export interface SyncRunPage { items: SyncRunView[]; nextCursor: string | null; hasPreviousPage: boolean }
