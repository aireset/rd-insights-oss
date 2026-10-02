import { z } from 'zod';

export const dataEndpointStatusSchema = z.enum(['unknown', 'available', 'partial', 'unavailable']);
const unknownEndpoint = { status: 'unknown' as const, checkedAt: null, reason: null };
export const dataEndpointViewSchema = z.object({
  status: dataEndpointStatusSchema,
  checkedAt: z.string().datetime().nullable(),
  reason: z.string().max(200).nullable(),
}).catch(unknownEndpoint).default(unknownEndpoint);
export const leadMissingFieldSchema = z.enum(['name', 'email', 'phone', 'jobTitle', 'city', 'state', 'lifecycleStage', 'fit', 'interest']);
export const leadDataCoverageSchema = z.object({
  details: dataEndpointViewSchema,
  funnel: dataEndpointViewSchema,
  conversions: dataEndpointViewSchema,
  opportunities: dataEndpointViewSchema,
  missingFields: z.array(leadMissingFieldSchema).catch([]).default([]),
});
export type DataEndpointStatus = z.infer<typeof dataEndpointStatusSchema>;
export type LeadDataEndpointView = z.infer<typeof dataEndpointViewSchema>;
export type LeadDataCoverage = z.infer<typeof leadDataCoverageSchema>;
export interface LeadDataFreshness { enrichedAt: string | null; historySyncedAt: string | null; coverage: LeadDataCoverage }
export interface SegmentCoverageView {
  id: string; name: string; selected: boolean; available: boolean;
  coverage: 'unknown' | 'partial' | 'complete'; lastScanAt: string | null; lastDeltaSyncAt: string | null;
}
