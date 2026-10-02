import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { leadsQuerySchema } from '@rd/shared';
import { buildWhere } from '../../leads/leads.service';
import { ClassificationController } from './classification.controller';

describe('classification access and filters', () => {
  it('keeps score filtering inside the authenticated account', () => {
    const query = leadsQuerySchema.parse({ aiScore: 'quente' });
    expect(buildWhere('account-a', query)).toMatchObject({ accountId: 'account-a', aiScore: 'quente' });
    expect(() => leadsQuerySchema.parse({ aiScore: 'invented' })).toThrow();
  });
  it('requires admin for pricing and regeneration but allows authenticated readers', () => {
    for (const method of ['policy', 'save', 'retry', 'classifyAll'] as const) expect(Reflect.getMetadata('requireAdmin', ClassificationController.prototype[method])).toBe(true);
    expect(Reflect.getMetadata('requireAdmin', ClassificationController.prototype.get)).toBeUndefined();
    expect(Reflect.getMetadata('requireAdmin', ClassificationController.prototype.distribution)).toBeUndefined();
  });
});
