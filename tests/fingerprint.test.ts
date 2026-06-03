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

  it('computes fingerprint for Go file', () => {
    const content = `package main

import "fmt"

func Add(a int, b int) int {
	return a + b
}

type User struct {
	Name string
	Age  int
}

func (u User) Greet() string {
	return "Hello, " + u.Name
}
`;
    const fp = computeFingerprint('src/main.go', content);
    expect(fp.filePath).toBe('src/main.go');
    expect(fp.functions).toHaveLength(2); // Add + Greet (method)
    expect(fp.functions[0].name).toBe('Add');
    expect(fp.functions[0].isExported).toBe(true);
    expect(fp.functions[1].name).toBe('Greet');
    expect(fp.classes).toHaveLength(1); // User struct
    expect(fp.classes[0].name).toBe('User');
    expect(fp.imports).toHaveLength(1);
    expect(fp.imports[0].source).toBe('fmt');
    expect(fp.exports).toHaveLength(3); // Add + User + Greet (exported methods too)
  });

  it('computes fingerprint for Java file', () => {
    const content = `package com.example;

import java.util.List;

public class UserService {
    private String name;

    public UserService(String name) {
        this.name = name;
    }

    public String getName() {
        return name;
    }

    public List<String> findAll() {
        return List.of();
    }
}
`;
    const fp = computeFingerprint('src/UserService.java', content);
    expect(fp.filePath).toBe('src/UserService.java');
    expect(fp.classes).toHaveLength(1);
    expect(fp.classes[0].name).toBe('UserService');
    expect(fp.classes[0].methods).toContain('getName');
    expect(fp.classes[0].methods).toContain('findAll');
    expect(fp.classes[0].properties).toContain('name');
    expect(fp.imports).toHaveLength(1);
    expect(fp.imports[0].source).toBe('java.util.List');
    expect(fp.exports).toHaveLength(1);
    expect(fp.exports[0].name).toBe('UserService');
  });
});
