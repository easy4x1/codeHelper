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
});
