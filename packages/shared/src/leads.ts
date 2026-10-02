import { z } from 'zod';
import type { LeadDataFreshness } from './data-coverage';

const csv = z.preprocess((v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v), z.array(z.string()).optional());
const segmentIds = z.preprocess((v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v), z.array(z.string().trim().min(1).max(200)).optional()).transform((ids) => ids ? [...new Set(ids)] : undefined);
const bool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional());

export const LEAD_SORTS = ['name', 'lastConversionAt', 'firstConversionAt', 'conversionsCount', 'rdCreatedAt', 'lifecycleStage'] as const;
export const LEADS_DATE_TIME_ZONE = 'America/Sao_Paulo';

export const leadsQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  tags: csv,
  lifecycleStage: csv,
  segmentIds,
  segmentMatch: z.enum(['any', 'all']).default('any'),
  oportunidade: bool,
  cidade: z.string().trim().max(80).optional(),
  // Aceita UF parcial (digitação em andamento); o filtro só vale com 2 letras (buildWhere).
  uf: z.string().trim().max(2).transform((uf) => uf.toUpperCase()).optional(),
  aiScore: z.enum(['quente', 'morno', 'frio']).optional(),
  conversao: z.string().trim().max(200).optional(),
  de: z.coerce.date().optional(),
  ate: z.coerce.date().optional(),
  sort: z.enum(LEAD_SORTS).default('lastConversionAt'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type LeadsQuery = z.infer<typeof leadsQuerySchema>;

export interface LeadSegmentBadge { id: string; name: string }
export interface LeadRow {
  id: string; rdUuid: string; name: string | null; email: string | null; phone: string | null;
  city: string | null; state: string | null; company: string | null; jobTitle: string | null;
  tags: string[]; lifecycleStage: string | null; opportunity: boolean; fit: string | null; interest: number | null;
  conversionsCount: number; firstConversionAt: string | null; lastConversionAt: string | null; rdCreatedAt: string | null;
  segments: LeadSegmentBadge[];
  aiScore?: string | null;
}
export interface LeadEventRow { id: string; type: 'CONVERSION' | 'OPPORTUNITY'; identifier: string; occurredAt: string; payload: Record<string, unknown> }
export interface LeadDetail extends LeadRow { customFields: Record<string, unknown>; events: LeadEventRow[]; dataFreshness: LeadDataFreshness }
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
export interface LeadFacets { tags: Array<{ value: string; count: number }>; lifecycleStages: Array<{ value: string; count: number }>; conversoes: Array<{ value: string; count: number }> }

export const savedViewInputSchema = z.object({ name: z.string().trim().min(1).max(80), filters: leadsQuerySchema.omit({ page: true, pageSize: true }) });
export type SavedViewInput = z.infer<typeof savedViewInputSchema>;
export interface SavedViewView { id: string; name: string; filters: Record<string, unknown>; createdAt: string; updatedAt: string }
