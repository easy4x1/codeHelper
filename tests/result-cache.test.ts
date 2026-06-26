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

describe('ResultCache persistence', () => {
  it('exports and re-loads entries (survives across instances)', () => {
    const a = new ResultCache();
    const findings: Finding[] = [
      { id: 'f1', type: 'fault', description: 'Null deref', confidence: 0.8, nodeIds: ['n1'] },
    ];
    a.set('src/auth.ts', 'hash123', findings);

    const b = new ResultCache();
    b.load(a.export());

    const cached = b.get('src/auth.ts', 'hash123');
    expect(cached).toHaveLength(1);
    expect(cached![0].description).toBe('Null deref');
  });

  it('export returns deep copies (mutation does not leak back)', () => {
    const a = new ResultCache();
    a.set('x.ts', 'h', [{ id: 'f', type: 'fault', description: 'orig', confidence: 1, nodeIds: [] }]);
    const dump = a.export();
    dump[0].findings[0].description = 'MUTATED';
    expect(a.get('x.ts', 'h')![0].description).toBe('orig');
  });

  it('load tolerates undefined (fresh cache)', () => {
    const a = new ResultCache();
    a.load(undefined);
    expect(a.size()).toBe(0);
  });
});

describe('ResultCache eviction', () => {
  it('evicts the oldest entry once maxEntries is exceeded', () => {
    const cache = new ResultCache({ maxEntries: 2 });
    cache.set('a.ts', 'h', []);
    cache.set('b.ts', 'h', []);
    cache.set('c.ts', 'h', []); // exceeds cap of 2 → 'a.ts' evicted

    expect(cache.size()).toBe(2);
    expect(cache.get('a.ts', 'h')).toBeUndefined();
    expect(cache.get('b.ts', 'h')).toBeDefined();
    expect(cache.get('c.ts', 'h')).toBeDefined();
  });

  it('a cache hit refreshes recency, protecting the entry from eviction', () => {
    const cache = new ResultCache({ maxEntries: 2 });
    cache.set('a.ts', 'h', []);
    cache.set('b.ts', 'h', []);
    cache.get('a.ts', 'h');        // bump 'a' to most-recent
    cache.set('c.ts', 'h', []);    // evicts least-recent → 'b.ts'

    expect(cache.get('a.ts', 'h')).toBeDefined();
    expect(cache.get('b.ts', 'h')).toBeUndefined();
    expect(cache.get('c.ts', 'h')).toBeDefined();
  });

  it('caps entries restored via load', () => {
    const cache = new ResultCache({ maxEntries: 1 });
    cache.load([
      { key: 'a.ts::h', findings: [], timestamp: '2026-01-01T00:00:00Z' },
      { key: 'b.ts::h', findings: [], timestamp: '2026-01-02T00:00:00Z' },
    ]);
    expect(cache.size()).toBe(1);
  });
});
