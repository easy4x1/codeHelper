import { describe, it, expect, beforeEach } from 'vitest';
import { KnowledgeGraphBuilder } from '../src/core/knowledge-graph.js';
import { PropagationEngine } from '../src/core/propagation.js';
import type { PropagationOptions } from '../src/core/types.js';

describe('PropagationEngine', () => {
  let builder: KnowledgeGraphBuilder;
  let engine: PropagationEngine;

  beforeEach(() => {
    builder = new KnowledgeGraphBuilder();
    engine = new PropagationEngine(builder);
  });

  const defaultOptions: PropagationOptions = {
    direction: 'upstream',
    maxDepth: 10,
    minEdgeWeight: 0.0,
    includeTests: true,
  };

  it('traces upstream from a single entry point', () => {
    // A calls B calls C
    builder.addNode({ id: 'A', type: 'function', name: 'A' });
    builder.addNode({ id: 'B', type: 'function', name: 'B' });
    builder.addNode({ id: 'C', type: 'function', name: 'C' });
    builder.addEdge('A', 'B', 'calls', 1.0);
    builder.addEdge('B', 'C', 'calls', 1.0);

    const result = engine.trace(['B'], { ...defaultOptions, direction: 'upstream' });

    const affectedIds = result.affectedNodes.map(n => n.nodeId);
    expect(affectedIds).toContain('A');
    expect(affectedIds).not.toContain('B'); // entry point
    expect(affectedIds).not.toContain('C');
  });

  it('respects maxDepth', () => {
    // A calls B calls C
    builder.addNode({ id: 'A', type: 'function', name: 'A' });
    builder.addNode({ id: 'B', type: 'function', name: 'B' });
    builder.addNode({ id: 'C', type: 'function', name: 'C' });
    builder.addEdge('A', 'B', 'calls', 1.0);
    builder.addEdge('B', 'C', 'calls', 1.0);

    const result = engine.trace(['C'], { ...defaultOptions, direction: 'upstream', maxDepth: 1 });

    const affectedIds = result.affectedNodes.map(n => n.nodeId);
    expect(affectedIds).toContain('B');
    expect(affectedIds).not.toContain('A');
  });

  it('respects minEdgeWeight', () => {
    builder.addNode({ id: 'A', type: 'function', name: 'A' });
    builder.addNode({ id: 'B', type: 'function', name: 'B' });
    builder.addEdge('A', 'B', 'calls', 0.8);

    const result = engine.trace(['B'], { ...defaultOptions, direction: 'upstream', minEdgeWeight: 0.9 });

    expect(result.affectedNodes).toHaveLength(0);
  });

  it('traces both directions', () => {
    // A calls B calls C
    builder.addNode({ id: 'A', type: 'function', name: 'A' });
    builder.addNode({ id: 'B', type: 'function', name: 'B' });
    builder.addNode({ id: 'C', type: 'function', name: 'C' });
    builder.addEdge('A', 'B', 'calls', 1.0);
    builder.addEdge('B', 'C', 'calls', 1.0);

    const result = engine.trace(['B'], { ...defaultOptions, direction: 'both' });

    const affectedIds = result.affectedNodes.map(n => n.nodeId);
    expect(affectedIds).toContain('A'); // upstream
    expect(affectedIds).toContain('C'); // downstream
  });

  it('propagates through contains edges', () => {
    builder.addNode({ id: 'file1', type: 'file', name: 'file1.ts' });
    builder.addNode({ id: 'func1', type: 'function', name: 'func1' });
    builder.addEdge('file1', 'func1', 'contains', 1.0);

    const result = engine.trace(['file1'], { ...defaultOptions, direction: 'downstream' });

    const affectedIds = result.affectedNodes.map(n => n.nodeId);
    expect(affectedIds).toContain('func1');
  });

  it('propagates through imports edges', () => {
    builder.addNode({ id: 'module1', type: 'module', name: 'module1' });
    builder.addNode({ id: 'file1', type: 'file', name: 'file1.ts' });
    builder.addEdge('file1', 'module1', 'imports', 1.0);

    // module1 has a fault; trace upstream from module1 should find file1
    // because imports rule: propagateFromTarget=true (imported module fault affects importer)
    const result = engine.trace(['module1'], { ...defaultOptions, direction: 'upstream' });

    const affectedIds = result.affectedNodes.map(n => n.nodeId);
    expect(affectedIds).toContain('file1');
  });

  it('computes impact probability correctly', () => {
    // A calls B calls C
    builder.addNode({ id: 'A', type: 'function', name: 'A' });
    builder.addNode({ id: 'B', type: 'function', name: 'B' });
    builder.addNode({ id: 'C', type: 'function', name: 'C' });
    builder.addEdge('A', 'B', 'calls', 0.8);
    builder.addEdge('B', 'C', 'calls', 0.8);

    const result = engine.trace(['C'], { ...defaultOptions, direction: 'upstream' });

    const nodeB = result.affectedNodes.find(n => n.nodeId === 'B');
    const nodeA = result.affectedNodes.find(n => n.nodeId === 'A');

    expect(nodeB?.impactProbability).toBeCloseTo(0.8, 5);
    expect(nodeA?.impactProbability).toBeCloseTo(0.64, 5);
  });

  it('excludes test files when includeTests is false', () => {
    builder.addNode({ id: 'src', type: 'file', name: 'src.ts', filePath: 'src.ts' });
    builder.addNode({ id: 'test', type: 'file', name: 'src.test.ts', filePath: 'src.test.ts' });
    builder.addEdge('test', 'src', 'imports', 1.0);

    const result = engine.trace(['src'], { ...defaultOptions, direction: 'upstream', includeTests: false });

    const affectedIds = result.affectedNodes.map(n => n.nodeId);
    expect(affectedIds).not.toContain('test');
  });

  it('includes test files when includeTests is true', () => {
    builder.addNode({ id: 'src', type: 'file', name: 'src.ts', filePath: 'src.ts' });
    builder.addNode({ id: 'test', type: 'file', name: 'src.test.ts', filePath: 'src.test.ts' });
    builder.addEdge('test', 'src', 'imports', 1.0);

    const result = engine.trace(['src'], { ...defaultOptions, direction: 'upstream', includeTests: true });

    const affectedIds = result.affectedNodes.map(n => n.nodeId);
    expect(affectedIds).toContain('test');
  });
});
