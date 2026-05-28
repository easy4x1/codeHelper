import { describe, it, expect } from 'vitest';
import { computeFingerprint, classifyChange, type FileFingerprint } from '../src/core/fingerprint.js';
import { createHash } from '../src/utils/hash.js';

describe('hash utility', () => {
  it('creates consistent SHA-256 hash', () => {
    const hash1 = createHash('hello world');
    const hash2 = createHash('hello world');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });
});

describe('fingerprint', () => {
  it('computes fingerprint for a file', () => {
    const content = `import { foo } from './foo';
export function bar() { return foo(); }
export class Baz { run() {} }
`;
    const fp = computeFingerprint('src/test.ts', content);
    expect(fp.filePath).toBe('src/test.ts');
    expect(fp.contentHash).toHaveLength(64);
    expect(fp.functions).toHaveLength(1);
    expect(fp.functions[0].name).toBe('bar');
    expect(fp.classes).toHaveLength(1);
    expect(fp.classes[0].name).toBe('Baz');
    expect(fp.imports).toHaveLength(1);
    expect(fp.imports[0].source).toBe('./foo');
    expect(fp.exports).toHaveLength(2);
    expect(fp.totalLines).toBe(4);
    expect(fp.hasStructuralAnalysis).toBe(true);
  });

  it('classifies NONE change', () => {
    const old: FileFingerprint = {
      filePath: 'src/test.ts',
      contentHash: 'abc',
      functions: [{ name: 'foo', params: [], isExported: true, startLine: 1, endLine: 2 }],
      classes: [],
      imports: [],
      exports: [{ name: 'foo', type: 'function', line: 1 }],
      totalLines: 2,
      hasStructuralAnalysis: true,
    };
    const result = classifyChange(old, old);
    expect(result.changeLevel).toBe('NONE');
  });

  it('classifies COSMETIC change', () => {
    const old: FileFingerprint = {
      filePath: 'src/test.ts',
      contentHash: 'abc',
      functions: [{ name: 'foo', params: [], isExported: true, startLine: 1, endLine: 2 }],
      classes: [],
      imports: [],
      exports: [{ name: 'foo', type: 'function', line: 1 }],
      totalLines: 2,
      hasStructuralAnalysis: true,
    };
    const neu: FileFingerprint = {
      ...old,
      contentHash: 'def',
    };
    const result = classifyChange(old, neu);
    expect(result.changeLevel).toBe('COSMETIC');
  });

  it('classifies STRUCTURAL change', () => {
    const old: FileFingerprint = {
      filePath: 'src/test.ts',
      contentHash: 'abc',
      functions: [{ name: 'foo', params: [], isExported: true, startLine: 1, endLine: 2 }],
      classes: [],
      imports: [],
      exports: [{ name: 'foo', type: 'function', line: 1 }],
      totalLines: 2,
      hasStructuralAnalysis: true,
    };
    const neu: FileFingerprint = {
      ...old,
      contentHash: 'def',
      functions: [{ name: 'foo', params: ['x'], isExported: true, startLine: 1, endLine: 2 }],
    };
    const result = classifyChange(old, neu);
    expect(result.changeLevel).toBe('STRUCTURAL');
  });
});
