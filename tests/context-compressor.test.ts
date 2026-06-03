import { describe, it, expect } from 'vitest';
import { ContextCompressor } from '../src/core/context-compressor.js';
import type { FileFingerprint } from '../src/core/types.js';

describe('ContextCompressor', () => {
  const compressor = new ContextCompressor();

  it('passes through small files unchanged', () => {
    const smallContent = 'export function add(a: number, b: number): number { return a + b; }';
    const fp: FileFingerprint = {
      filePath: 'src/math.ts',
      contentHash: 'abc',
      functions: [{ name: 'add', params: ['a', 'b'], isExported: true, startLine: 1, endLine: 1 }],
      classes: [],
      imports: [],
      exports: [],
      totalLines: 1,
      hasStructuralAnalysis: true,
    };

    const compressed = compressor.compress('src/math.ts', smallContent, fp);
    expect(compressed).toBe(smallContent);
  });

  it('compresses large files to structural summary', () => {
    const largeContent = Array(100).fill('function f() { return 1; }').join('\n');
    const fp: FileFingerprint = {
      filePath: 'src/big.ts',
      contentHash: 'def',
      functions: [
        { name: 'getUser', params: ['id'], isExported: true, startLine: 1, endLine: 10 },
        { name: 'saveUser', params: ['user'], isExported: true, startLine: 11, endLine: 20 },
      ],
      classes: [
        { name: 'UserService', methods: ['getUser', 'saveUser'], properties: ['db'], isExported: true, startLine: 21, endLine: 40 },
      ],
      imports: [{ source: './db', items: ['Database'], line: 1 }],
      exports: [{ name: 'UserService', type: 'class', line: 40 }],
      totalLines: 100,
      hasStructuralAnalysis: true,
    };

    const compressed = compressor.compress('src/big.ts', largeContent, fp);
    expect(compressed.length).toBeLessThan(largeContent.length);
    expect(compressed).toContain('getUser(id)');
    expect(compressed).toContain('UserService');
    expect(compressed).toContain('import { Database } from');
  });

  it('falls back to full content when fingerprint is unavailable', () => {
    const content = 'function test() {}';
    const compressed = compressor.compress('src/unknown.ts', content, undefined);
    expect(compressed).toBe(content);
  });

  it('includes class methods and properties', () => {
    const content = Array(50).fill('x').join('\n');
    const fp: FileFingerprint = {
      filePath: 'src/service.ts',
      contentHash: 'ghi',
      functions: [],
      classes: [
        { name: 'AuthService', methods: ['login', 'logout'], properties: ['token', 'user'], isExported: true, startLine: 1, endLine: 50 },
      ],
      imports: [],
      exports: [],
      totalLines: 50,
      hasStructuralAnalysis: true,
    };

    const compressed = compressor.compress('src/service.ts', content, fp);
    expect(compressed).toContain('AuthService');
    expect(compressed).toContain('Methods: login, logout');
    expect(compressed).toContain('Properties: token, user');
  });
});
