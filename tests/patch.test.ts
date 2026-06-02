import { describe, it, expect } from 'vitest';
import { generatePatch, applyPatch, type FilePatch } from '../src/core/patch.js';

describe('generatePatch', () => {
  it('creates a patch for modified content', () => {
    const original = 'function greet() {\n  return "hello";\n}';
    const modified = 'function greet() {\n  return "hello world";\n}';
    const patch = generatePatch('src/greet.ts', original, modified);
    expect(patch.filePath).toBe('src/greet.ts');
    expect(patch.changeType).toBe('modify');
    expect(patch.originalCode).toBe(original);
    expect(patch.modifiedCode).toBe(modified);
    expect(patch.diff).toContain('-   return "hello";');
    expect(patch.diff).toContain('+   return "hello world";');
  });

  it('creates a patch for new file', () => {
    const modified = 'export const config = {};\n';
    const patch = generatePatch('src/config.ts', undefined, modified);
    expect(patch.changeType).toBe('add');
    expect(patch.originalCode).toBeUndefined();
    expect(patch.modifiedCode).toBe(modified);
  });

  it('creates a patch for deleted file', () => {
    const original = 'export const old = true;\n';
    const patch = generatePatch('src/old.ts', original, undefined);
    expect(patch.changeType).toBe('delete');
    expect(patch.originalCode).toBe(original);
    expect(patch.modifiedCode).toBeUndefined();
  });
});

describe('applyPatch', () => {
  it('applies a modify patch', () => {
    const original = 'function greet() {\n  return "hello";\n}';
    const modified = 'function greet() {\n  return "hello world";\n}';
    const patch = generatePatch('src/greet.ts', original, modified);
    const result = applyPatch(patch);
    expect(result).toBe(modified);
  });

  it('applies an add patch', () => {
    const modified = 'export const config = {};\n';
    const patch = generatePatch('src/config.ts', undefined, modified);
    const result = applyPatch(patch);
    expect(result).toBe(modified);
  });

  it('applies a delete patch', () => {
    const original = 'export const old = true;\n';
    const patch = generatePatch('src/old.ts', original, undefined);
    const result = applyPatch(patch);
    expect(result).toBe('');
  });

  it('fails when original does not match for modify', () => {
    const patch: FilePatch = {
      filePath: 'src/greet.ts',
      changeType: 'modify',
      originalCode: 'wrong content',
      modifiedCode: 'new content',
      diff: '',
    };
    expect(() => applyPatch(patch, 'actual content')).toThrow();
  });
});
