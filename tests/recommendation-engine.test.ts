import { describe, it, expect } from 'vitest';
import { RecommendationEngine } from '../src/core/recommendation-engine.js';
import type { FaultPattern, FixPattern, Convention } from '../src/core/types.js';

describe('RecommendationEngine', () => {
  const engine = new RecommendationEngine();

  const patterns: FaultPattern[] = [
    { id: 'fp-1', pattern: 'Potential null dereference', frequency: 5 },
    { id: 'fp-2', pattern: 'Unused variable', frequency: 3 },
    { id: 'fp-3', pattern: 'Memory leak in useEffect', frequency: 2 },
  ];

  const fixes: FixPattern[] = [
    { id: 'fix-1', pattern: 'Add optional chaining', frequency: 5 },
    { id: 'fix-2', pattern: 'Remove unused code', frequency: 3 },
  ];

  const conventions: Convention[] = [
    { id: 'c1', category: 'naming', rule: 'Use camelCase', examples: ['getUser'], confidence: 0.9 },
  ];

  it('recommends patterns for a similar problem', () => {
    const recommendations = engine.recommend('Fix null pointer in auth module', patterns, fixes, conventions);
    expect(recommendations.length).toBeGreaterThan(0);
    expect(recommendations[0].type).toBe('fault');
  });

  it('ranks by similarity score', () => {
    const recommendations = engine.recommend('Memory leak issue', patterns, fixes, conventions);
    const memoryLeakRec = recommendations.find(r => r.title.includes('Memory leak'));
    expect(memoryLeakRec).toBeDefined();
    expect(memoryLeakRec!.score).toBeGreaterThan(0);
  });

  it('includes convention recommendations', () => {
    const recommendations = engine.recommend('Check naming', patterns, fixes, conventions);
    expect(recommendations.some(r => r.type === 'convention')).toBe(true);
  });

  it('returns empty for unknown problems', () => {
    const recommendations = engine.recommend('Quantum computing algorithm', patterns, fixes, conventions);
    expect(recommendations.filter(r => r.score > 0.3).length).toBe(0);
  });
});
