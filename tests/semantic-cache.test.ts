import { describe, it, expect } from 'vitest';
import { SemanticCache } from '../src/core/semantic-cache.js';
import type { SolutionPlan } from '../src/core/types.js';

describe('SemanticCache', () => {
  const cache = new SemanticCache();

  const samplePlan: SolutionPlan = {
    id: 'plan-1',
    timestamp: new Date().toISOString(),
    taskId: 'task-1',
    problem: { description: 'Fix null dereference', rootCause: 'Missing check', severity: 'high' },
    changes: [{ filePath: 'src/auth.ts', changeType: 'modify', description: 'Add optional chaining', reasoning: 'null safety' }],
    metadata: { confidence: 0.9, tokenUsed: 500 },
  };

  it('returns undefined for unknown query', () => {
    const result = cache.findSimilar('completely unrelated problem about quantum physics');
    expect(result).toBeUndefined();
  });

  it('finds exact match', () => {
    cache.store('Fix null dereference in auth module', samplePlan);
    const result = cache.findSimilar('Fix null dereference in auth module');
    expect(result).toBeDefined();
    expect(result!.id).toBe('plan-1');
  });

  it('finds similar match with different wording', () => {
    cache.store('Fix null dereference in auth module', samplePlan);
    const result = cache.findSimilar('auth module null pointer fix');
    expect(result).toBeDefined();
    expect(result!.id).toBe('plan-1');
  });

  it('returns undefined when similarity is below threshold', () => {
    cache.store('Fix null dereference in auth module', samplePlan);
    const result = cache.findSimilar('memory leak in useEffect react', 0.8);
    expect(result).toBeUndefined();
  });

  it('returns deep copy (defensive)', () => {
    cache.store('Fix null dereference', samplePlan);
    const cached = cache.findSimilar('Fix null dereference')!;
    cached.problem.description = 'MODIFIED';

    const reFetched = cache.findSimilar('Fix null dereference')!;
    expect(reFetched.problem.description).toBe('Fix null dereference');
  });

  it('stores multiple entries', () => {
    const plan2: SolutionPlan = {
      ...samplePlan,
      id: 'plan-2',
      problem: { description: 'Unused variable cleanup', rootCause: 'Dead code', severity: 'low' },
    };

    cache.store('Fix null dereference', samplePlan);
    cache.store('Remove unused variables', plan2);

    expect(cache.findSimilar('Fix null dereference')?.id).toBe('plan-1');
    expect(cache.findSimilar('Remove unused variables')?.id).toBe('plan-2');
  });

  it('export/load round-trips entries across instances', () => {
    const source = new SemanticCache();
    source.store('Fix null dereference in auth module', samplePlan);

    const restored = new SemanticCache();
    restored.load(source.export());

    expect(restored.size()).toBe(1);
    expect(restored.findSimilar('auth module null pointer fix')?.id).toBe('plan-1');
  });

  it('load(undefined) yields an empty cache', () => {
    const c = new SemanticCache();
    c.store('whatever problem here', samplePlan);
    c.load(undefined);
    expect(c.size()).toBe(0);
  });

  it('evicts oldest entries beyond maxEntries', () => {
    const c = new SemanticCache({ maxEntries: 2 });
    c.store('first unique alpha problem', { ...samplePlan, id: 'p1' });
    c.store('second unique bravo problem', { ...samplePlan, id: 'p2' });
    c.store('third unique charlie problem', { ...samplePlan, id: 'p3' });
    expect(c.size()).toBe(2);
    // oldest ("alpha") evicted
    expect(c.findSimilar('first unique alpha problem')).toBeUndefined();
    expect(c.findSimilar('third unique charlie problem')?.id).toBe('p3');
  });
});
