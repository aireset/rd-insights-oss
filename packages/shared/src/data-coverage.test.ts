import { describe, expect, it } from 'vitest';
import { leadDataCoverageSchema } from './data-coverage';

describe('lead endpoint coverage', () => {
  it('keeps legacy data unknown without inventing successful reads', () => {
    const coverage = leadDataCoverageSchema.parse({});
    for (const endpoint of [coverage.details, coverage.funnel, coverage.conversions, coverage.opportunities]) {
      expect(endpoint).toEqual({ status: 'unknown', checkedAt: null, reason: null });
    }
    expect(coverage.missingFields).toEqual([]);
  });

  it('exposes only supported metadata and field names', () => {
    const coverage = leadDataCoverageSchema.parse({ details: { status: 'available', checkedAt: '2026-09-28T22:00:00.000Z', reason: null, raw: { secret: 'hidden' } }, raw: { token: 'hidden' }, missingFields: ['email'] });
    expect(coverage.details.status).toBe('available');
    expect(coverage.missingFields).toEqual(['email']);
    expect(JSON.stringify(coverage)).not.toContain('hidden');
  });
});
