import { describe, it, expect } from 'vitest';
import { LlmSemanticCache } from '../src/core/llm-semantic-cache.js';

describe('LlmSemanticCache', () => {
  it('stores and retrieves results', () => {
    const cache = new LlmSemanticCache();
    cache.set('summary:file:src/index.ts:abc', { summary: 'Main entry', tags: ['entry'] });
    expect(cache.get('summary:file:src/index.ts:abc')).toEqual({ summary: 'Main entry', tags: ['entry'] });
  });

  it('returns undefined for missing keys', () => {
    const cache = new LlmSemanticCache();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('hydrates from initial entries', () => {
    const cache = new LlmSemanticCache([
      { key: 'layer:file:src/a.ts:hash', result: { layer: 'service', confidence: 0.8 }, timestamp: '2026-01-01' },
    ]);
    expect(cache.get('layer:file:src/a.ts:hash')).toEqual({ layer: 'service', confidence: 0.8 });
  });

  it('exports all entries', () => {
    const cache = new LlmSemanticCache();
    cache.set('k1', 'v1');
    cache.set('k2', 'v2');
    const exported = cache.export();
    expect(exported).toHaveLength(2);
    expect(exported.map(e => e.key).sort()).toEqual(['k1', 'k2']);
  });

  it('overwrites existing keys', () => {
    const cache = new LlmSemanticCache();
    cache.set('k', { a: 1 });
    cache.set('k', { a: 2 });
    expect(cache.get('k')).toEqual({ a: 2 });
  });
});
