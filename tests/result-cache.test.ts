import { describe, it, expect } from 'vitest';
import { ResultCache } from '../src/core/result-cache.js';
import type { Finding } from '../src/core/types.js';

describe('ResultCache', () => {
  const cache = new ResultCache();

  it('returns undefined for uncached file', () => {
    const result = cache.get('src/auth.ts', 'hash123');
    expect(result).toBeUndefined();
  });

  it('caches and retrieves findings', () => {
    const findings: Finding[] = [
      { id: 'f1', type: 'fault', description: 'Null dereference', confidence: 0.8, nodeIds: ['n1'] },
    ];

    cache.set('src/auth.ts', 'hash123', findings);
    const cached = cache.get('src/auth.ts', 'hash123');

    expect(cached).toHaveLength(1);
    expect(cached![0].description).toBe('Null dereference');
  });

  it('returns undefined when hash changes', () => {
    const findings: Finding[] = [
      { id: 'f1', type: 'fault', description: 'Null dereference', confidence: 0.8, nodeIds: ['n1'] },
    ];

    cache.set('src/auth.ts', 'hash123', findings);
    const cached = cache.get('src/auth.ts', 'hash456');

    expect(cached).toBeUndefined();
  });

  it('returns deep copies (defensive)', () => {
    const findings: Finding[] = [
      { id: 'f1', type: 'fault', description: 'Null dereference', confidence: 0.8, nodeIds: ['n1'] },
    ];

    cache.set('src/auth.ts', 'hash123', findings);
    const cached = cache.get('src/auth.ts', 'hash123')!;
    cached[0].description = 'MODIFIED';

    const reFetched = cache.get('src/auth.ts', 'hash123')!;
    expect(reFetched[0].description).toBe('Null dereference');
  });

  it('clears all entries', () => {
    cache.set('a.ts', 'h1', []);
    cache.clear();
    expect(cache.get('a.ts', 'h1')).toBeUndefined();
  });
});
