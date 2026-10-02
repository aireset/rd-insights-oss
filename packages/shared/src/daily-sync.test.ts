import { describe, expect, it } from 'vitest';
import { refreshBudgetSchema } from './daily-sync';

describe('refresh request budget input', () => {
  it('accepts one request and rejects invalid or unbounded limits', () => {
    expect(refreshBudgetSchema.parse({ dailyBudget: 1 })).toEqual({ dailyBudget: 1 });
    for (const dailyBudget of [0, -1, 1.5, 100_001, '100', NaN]) {
      expect(refreshBudgetSchema.safeParse({ dailyBudget }).success).toBe(false);
    }
  });
});
