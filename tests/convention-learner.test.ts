import { describe, it, expect } from 'vitest';
import { ConventionLearner } from '../src/core/convention-learner.js';
import type { FileFingerprint } from '../src/core/types.js';

describe('ConventionLearner', () => {
  const learner = new ConventionLearner();

  it('learns camelCase naming from function signatures', () => {
    const fingerprints: FileFingerprint[] = [
      {
        filePath: 'src/utils.ts',
        contentHash: 'abc',
        functions: [
          { name: 'getUserName', params: [], isExported: true, startLine: 1, endLine: 1 },
          { name: 'fetchData', params: [], isExported: true, startLine: 2, endLine: 2 },
          { name: 'processItems', params: [], isExported: false, startLine: 3, endLine: 3 },
        ],
        classes: [],
        imports: [],
        exports: [],
        totalLines: 10,
        hasStructuralAnalysis: true,
      },
    ];

    const conventions = learner.learnNamingConventions(fingerprints);
    expect(conventions.length).toBeGreaterThan(0);
    expect(conventions[0].category).toBe('naming');
    expect(conventions[0].rule).toContain('camelCase');
    expect(conventions[0].confidence).toBeGreaterThan(0.5);
  });

  it('learns PascalCase for classes', () => {
    const fingerprints: FileFingerprint[] = [
      {
        filePath: 'src/models.ts',
        contentHash: 'def',
        functions: [],
        classes: [
          { name: 'UserModel', methods: [], properties: [], isExported: true, startLine: 1, endLine: 1 },
          { name: 'AuthService', methods: [], properties: [], isExported: true, startLine: 2, endLine: 2 },
        ],
        imports: [],
        exports: [],
        totalLines: 10,
        hasStructuralAnalysis: true,
      },
    ];

    const conventions = learner.learnNamingConventions(fingerprints);
    expect(conventions.some(c => c.rule.includes('PascalCase'))).toBe(true);
  });

  it('detects test file naming convention', () => {
    const fingerprints: FileFingerprint[] = [
      {
        filePath: 'src/auth.test.ts',
        contentHash: 'ghi',
        functions: [{ name: 'testAuth', params: [], isExported: false, startLine: 1, endLine: 1 }],
        classes: [],
        imports: [],
        exports: [],
        totalLines: 10,
        hasStructuralAnalysis: true,
      },
      {
        filePath: 'src/utils.test.ts',
        contentHash: 'jkl',
        functions: [{ name: 'testUtils', params: [], isExported: false, startLine: 1, endLine: 1 }],
        classes: [],
        imports: [],
        exports: [],
        totalLines: 10,
        hasStructuralAnalysis: true,
      },
    ];

    const conventions = learner.learnTestingConventions(fingerprints);
    expect(conventions.some(c => c.rule.includes('.test.'))).toBe(true);
  });
});
