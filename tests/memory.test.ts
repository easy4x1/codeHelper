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
});
