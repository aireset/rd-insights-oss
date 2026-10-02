import { describe, expect, it } from 'vitest';
import { combineCommittedMicros, isClassificationAiFeature } from './account-budget';

describe('shared AI account budget accounting', () => {
  it('counts classification attempts once and excludes their mirrored logs', () => {
    expect(isClassificationAiFeature('classification.manual')).toBe(true);
    expect(isClassificationAiFeature('typed-chat')).toBe(false);
    expect(combineCommittedMicros(125n, 40n)).toBe(165n);
  });
});
