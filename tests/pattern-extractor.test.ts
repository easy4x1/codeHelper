import { describe, it, expect } from 'vitest';
import { PatternExtractor } from '../src/core/pattern-extractor.js';
import type { Finding, SolutionPlan, FileChange } from '../src/core/types.js';

describe('PatternExtractor', () => {
  const extractor = new PatternExtractor();

  it('extracts fault patterns from findings', () => {
    const findings: Finding[] = [
      { id: 'f1', type: 'fault', description: 'Potential null dereference in auth.ts', confidence: 0.8, nodeIds: ['n1'] },
      { id: 'f2', type: 'fault', description: 'Potential null dereference in user.ts', confidence: 0.7, nodeIds: ['n2'] },
      { id: 'f3', type: 'style', description: 'Unused variable x', confidence: 0.6, nodeIds: ['n3'] },
    ];

    const patterns = extractor.extractFaultPatterns(findings);
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.some(p => p.pattern.includes('null'))).toBe(true);
    expect(patterns.some(p => p.pattern.includes('Unused variable'))).toBe(true);
  });

  it('extracts fix patterns from patches', () => {
    const plan: SolutionPlan = {
      id: 'plan-1',
      timestamp: new Date().toISOString(),
      taskId: 'task-1',
      problem: { description: 'Fix null', rootCause: 'Missing check', severity: 'high' },
      changes: [
        { filePath: 'src/auth.ts', changeType: 'modify', description: 'Add optional chaining', reasoning: 'null safety', originalCode: 'user.name', modifiedCode: 'user?.name' },
      ],
      metadata: { confidence: 0.9, tokenUsed: 100 },
    };

    const patterns = extractor.extractFixPatterns(plan);
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns[0].pattern).toContain('optional chaining');
  });

  it('normalizes similar descriptions into one pattern', () => {
    const findings: Finding[] = [
      { id: 'f1', type: 'fault', description: 'Potential null dereference', confidence: 0.8, nodeIds: [] },
      { id: 'f2', type: 'fault', description: 'Potential null/undefined dereference', confidence: 0.7, nodeIds: [] },
    ];

    const patterns = extractor.extractFaultPatterns(findings);
    // Should merge similar descriptions
    expect(patterns.length).toBeLessThan(findings.length);
  });
});
