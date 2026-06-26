import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryMiddleware } from '../src/core/memory.js';
import type { KnowledgeGraph, FileFingerprint } from '../src/core/types.js';

describe('MemoryMiddleware', () => {
  let memory: MemoryMiddleware;

  beforeEach(() => {
    memory = new MemoryMiddleware();
  });

  it('initializes with empty state', () => {
    expect(memory.getRepoMemory().knowledgeGraph.nodes).toHaveLength(0);
    expect(memory.getRepoMemory().fingerprints).toEqual({});
  });

  it('saves and loads repo memory', () => {
    const graph: KnowledgeGraph = {
      nodes: [{ id: 'a', type: 'file', name: 'a.ts' }],
      edges: [],
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    };
    memory.setRepoMemory({ ...memory.getRepoMemory(), knowledgeGraph: graph });
    expect(memory.getRepoMemory().knowledgeGraph.nodes).toHaveLength(1);
  });

  it('tracks task context', () => {
    memory.startTask('task-1');
    expect(memory.getTaskContext().taskId).toBe('task-1');
    memory.markFileAnalyzed('src/foo.ts');
    expect(memory.getTaskContext().analyzedFiles.has('src/foo.ts')).toBe(true);
  });

  it('stores fingerprints', () => {
    const fp: FileFingerprint = {
      filePath: 'src/foo.ts',
      contentHash: 'abc',
      functions: [],
      classes: [],
      imports: [],
      exports: [],
      totalLines: 10,
      hasStructuralAnalysis: true,
    };
    memory.setFingerprint(fp);
    expect(memory.getFingerprint('src/foo.ts')).toEqual(fp);
  });

  it('serializes and deserializes', () => {
    memory.startTask('task-1');
    const fp: FileFingerprint = {
      filePath: 'src/foo.ts',
      contentHash: 'abc',
      functions: [],
      classes: [],
      imports: [],
      exports: [],
      totalLines: 10,
      hasStructuralAnalysis: true,
    };
    memory.setFingerprint(fp);

    const json = memory.serialize();
    const restored = MemoryMiddleware.deserialize(json);
    expect(restored.getFingerprint('src/foo.ts')).toEqual(fp);
    expect(restored.getTaskContext().taskId).toBe('task-1');
  });

  it('persists semantic cache entries through serialization', () => {
    memory.setSemanticCache([
      { keywords: ['null', 'auth'], plan: { id: 'p1' } as never, timestamp: '2026-06-25T00:00:00.000Z' },
    ]);

    const restored = MemoryMiddleware.deserialize(memory.serialize());
    const entries = restored.getSemanticCache();
    expect(entries).toHaveLength(1);
    expect(entries[0].keywords).toEqual(['null', 'auth']);
  });

  it('persists embedding cache entries through serialization', () => {
    memory.setEmbeddingCache([
      { key: 'bge:384:abc', vector: [0.1, 0.2, 0.3] },
      { key: 'bge:384:def', vector: [0.4, 0.5, 0.6] },
    ]);

    const restored = MemoryMiddleware.deserialize(memory.serialize());
    const entries = restored.getEmbeddingCache();
    expect(entries).toHaveLength(2);
    expect(entries[0].key).toBe('bge:384:abc');
    expect(entries[0].vector).toEqual([0.1, 0.2, 0.3]);
  });
});

describe('LearnedMemory (L3) — Phase 5', () => {
  it('records a completed task', () => {
    const memory = new MemoryMiddleware();
    memory.recordTask({
      taskId: 'task-1',
      description: 'Fix null dereference',
      timestamp: new Date().toISOString(),
      filesAnalyzed: ['src/auth.ts'],
      findingsCount: 2,
      success: true,
    });
    const learned = memory.getLearnedMemory();
    expect(learned.taskHistory).toHaveLength(1);
    expect(learned.taskHistory[0].description).toBe('Fix null dereference');
  });

  it('extracts and stores fault patterns', () => {
    const memory = new MemoryMiddleware();
    memory.addFaultPattern({
      id: 'fp-null-deref',
      pattern: 'Potential null/undefined dereference',
      language: 'typescript',
      frequency: 1,
    });
    const learned = memory.getLearnedMemory();
    expect(learned.faultPatterns).toHaveLength(1);
    expect(learned.faultPatterns[0].frequency).toBe(1);
  });

  it('increments frequency for existing fault patterns', () => {
    const memory = new MemoryMiddleware();
    memory.addFaultPattern({ id: 'fp-1', pattern: 'Unused variable', frequency: 1 });
    memory.addFaultPattern({ id: 'fp-1', pattern: 'Unused variable', frequency: 1 });
    const learned = memory.getLearnedMemory();
    expect(learned.faultPatterns[0].frequency).toBe(2);
  });

  it('increments frequency for existing fix patterns', () => {
    const memory = new MemoryMiddleware();
    memory.addFixPattern({ id: 'fix-1', pattern: 'Add optional chaining', frequency: 1 });
    memory.addFixPattern({ id: 'fix-1', pattern: 'Add optional chaining', frequency: 2 });
    const learned = memory.getLearnedMemory();
    expect(learned.fixPatterns[0].frequency).toBe(3);
  });

  it('stores project conventions', () => {
    const memory = new MemoryMiddleware();
    memory.addConvention({
      id: 'conv-1',
      category: 'naming',
      rule: 'Functions use camelCase',
      examples: ['getUserName', 'fetchData'],
      confidence: 0.9,
    });
    const learned = memory.getLearnedMemory();
    expect(learned.projectConventions).toHaveLength(1);
    expect(learned.projectConventions[0].category).toBe('naming');
  });

  it('boosts confidence for duplicate conventions', () => {
    const memory = new MemoryMiddleware();
    memory.addConvention({
      id: 'conv-1',
      category: 'naming',
      rule: 'Functions use camelCase',
      examples: ['getUserName'],
      confidence: 0.5,
    });
    memory.addConvention({
      id: 'conv-2',
      category: 'naming',
      rule: 'Functions use camelCase',
      examples: ['fetchData'],
      confidence: 0.6,
    });
    const learned = memory.getLearnedMemory();
    expect(learned.projectConventions).toHaveLength(1);
    expect(learned.projectConventions[0].confidence).toBeCloseTo(0.6, 1);
  });

  it('filters conventions by category', () => {
    const memory = new MemoryMiddleware();
    memory.addConvention({
      id: 'conv-1',
      category: 'naming',
      rule: 'Functions use camelCase',
      examples: ['getUserName'],
      confidence: 0.9,
    });
    memory.addConvention({
      id: 'conv-2',
      category: 'testing',
      rule: 'Tests use .test.ts suffix',
      examples: ['auth.test.ts'],
      confidence: 0.8,
    });
    const namingConventions = memory.getConventions('naming');
    expect(namingConventions).toHaveLength(1);
    expect(namingConventions[0].category).toBe('naming');
    expect(memory.getConventions()).toHaveLength(2);
  });

  it('returns deep copies from getTaskHistory and getConventions', () => {
    const memory = new MemoryMiddleware();
    memory.recordTask({
      taskId: 'task-1',
      description: 'Fix bug',
      timestamp: new Date().toISOString(),
      filesAnalyzed: ['src/a.ts'],
      findingsCount: 1,
    });
    memory.addConvention({
      id: 'conv-1',
      category: 'style',
      rule: 'Use single quotes',
      examples: ["'hello'"],
      confidence: 0.7,
    });

    const history = memory.getTaskHistory();
    history[0].description = 'Mutated';
    expect(memory.getTaskHistory()[0].description).toBe('Fix bug');

    const conventions = memory.getConventions();
    conventions[0].rule = 'Mutated';
    expect(memory.getConventions()[0].rule).toBe('Use single quotes');
  });
});
