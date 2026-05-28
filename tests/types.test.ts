import { describe, it, expect } from 'vitest';
import type { FileFingerprint, ChangeLevel, KnowledgeGraph, GraphNode, GraphEdge } from '../src/core/types.js';

describe('types', () => {
  it('FileFingerprint interface is usable', () => {
    const fp: FileFingerprint = {
      filePath: 'src/index.ts',
      contentHash: 'abc123',
      functions: [],
      classes: [],
      imports: [],
      exports: [],
      totalLines: 100,
      hasStructuralAnalysis: true,
    };
    expect(fp.filePath).toBe('src/index.ts');
  });

  it('ChangeLevel union works', () => {
    const levels: ChangeLevel[] = ['NONE', 'COSMETIC', 'STRUCTURAL', 'SEMANTIC'];
    expect(levels).toHaveLength(4);
  });

  it('KnowledgeGraph can be constructed', () => {
    const node: GraphNode = {
      id: 'file:src/index.ts',
      type: 'file',
      name: 'index.ts',
      filePath: 'src/index.ts',
    };
    const edge: GraphEdge = {
      id: 'edge-1',
      source: 'file:src/index.ts',
      target: 'function:src/index.ts:main',
      type: 'contains',
      weight: 1.0,
    };
    const graph: KnowledgeGraph = {
      nodes: [node],
      edges: [edge],
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    };
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(1);
  });
});
