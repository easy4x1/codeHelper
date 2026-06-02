import { describe, it, expect } from 'vitest';
import { KnowledgeGraphBuilder, mergeGraphs } from '../src/core/knowledge-graph.js';
import type { GraphNode, GraphEdge } from '../src/core/types.js';

describe('KnowledgeGraphBuilder', () => {
  it('creates empty graph', () => {
    const builder = new KnowledgeGraphBuilder();
    const graph = builder.build();
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });

  it('adds nodes and builds', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'file:src/index.ts', type: 'file', name: 'index.ts' });
    builder.addNode({ id: 'function:src/index.ts:main', type: 'function', name: 'main' });
    const graph = builder.build();
    expect(graph.nodes).toHaveLength(2);
  });

  it('adds edges', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'file:src/index.ts', type: 'file', name: 'index.ts' });
    builder.addNode({ id: 'function:src/index.ts:main', type: 'function', name: 'main' });
    builder.addEdge('file:src/index.ts', 'function:src/index.ts:main', 'contains', 1.0);
    const graph = builder.build();
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].type).toBe('contains');
  });

  it('prevents duplicate nodes', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'file:src/index.ts', type: 'file', name: 'index.ts' });
    builder.addNode({ id: 'file:src/index.ts', type: 'file', name: 'index.ts' });
    const graph = builder.build();
    expect(graph.nodes).toHaveLength(1);
  });

  it('finds node by id', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'file:src/index.ts', type: 'file', name: 'index.ts' });
    expect(builder.findNode('file:src/index.ts')).toBeDefined();
    expect(builder.findNode('nonexistent')).toBeUndefined();
  });

  it('finds neighbors', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'a', type: 'file', name: 'a.ts' });
    builder.addNode({ id: 'b', type: 'function', name: 'b' });
    builder.addNode({ id: 'c', type: 'function', name: 'c' });
    builder.addEdge('a', 'b', 'contains', 1.0);
    builder.addEdge('a', 'c', 'contains', 1.0);
    const neighbors = builder.findNeighbors('a', 'contains');
    expect(neighbors).toHaveLength(2);
  });

  it('serializes and deserializes', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'a', type: 'file', name: 'a.ts' });
    builder.addEdge('a', 'b', 'contains', 1.0);
    const graph = builder.build();

    const json = JSON.stringify(graph);
    const parsed = JSON.parse(json);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.edges).toHaveLength(1);
  });

  it('gets nodes by type', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'a', type: 'file', name: 'a.ts' });
    builder.addNode({ id: 'b', type: 'function', name: 'b' });
    builder.addNode({ id: 'c', type: 'function', name: 'c' });
    const functions = builder.getNodesByType('function');
    expect(functions).toHaveLength(2);
    expect(functions.map(n => n.name)).toContain('b');
    expect(functions.map(n => n.name)).toContain('c');
  });

  it('reconstructs from existing graph', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'a', type: 'file', name: 'a.ts' });
    builder.addNode({ id: 'b', type: 'function', name: 'b' });
    builder.addEdge('a', 'b', 'contains', 1.0);
    const graph = builder.build();

    const rebuilt = KnowledgeGraphBuilder.fromGraph(graph);
    expect(rebuilt.findNode('a')).toBeDefined();
    expect(rebuilt.findNeighbors('a')).toHaveLength(1);
  });

  it('merges two graphs', () => {
    const builder1 = new KnowledgeGraphBuilder();
    builder1.addNode({ id: 'a', type: 'file', name: 'a.ts' });
    const graph1 = builder1.build();

    const builder2 = new KnowledgeGraphBuilder();
    builder2.addNode({ id: 'b', type: 'file', name: 'b.ts' });
    builder2.addEdge('b', 'c', 'contains', 1.0);
    const graph2 = builder2.build();

    const merged = mergeGraphs(graph1, graph2);
    expect(merged.nodes).toHaveLength(2);
    expect(merged.edges).toHaveLength(1);
  });

  it('removes node and cleans up type index', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'a', type: 'file', name: 'a.ts' });
    builder.addNode({ id: 'b', type: 'function', name: 'b' });

    expect(builder.getNodesByType('file')).toHaveLength(1);
    builder.removeNode('a');
    expect(builder.getNodesByType('file')).toHaveLength(0);
    expect(builder.getNodesByType('function')).toHaveLength(1);
  });

  it('removes connected edges when removing a node (no orphan edges)', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'a', type: 'file', name: 'a.ts' });
    builder.addNode({ id: 'b', type: 'function', name: 'b' });
    builder.addEdge('a', 'b', 'contains', 1.0);
    builder.addEdge('b', 'a', 'imports', 0.7);
    expect(builder.getEdgeCount()).toBe(2);

    builder.removeNode('a');
    expect(builder.getEdgeCount()).toBe(0);
    expect(builder.getEdgesBySource('a')).toHaveLength(0);
    expect(builder.getEdgesByTarget('a')).toHaveLength(0);
    expect(builder.getEdgesBySource('b')).toHaveLength(0);
    expect(builder.getEdgesByTarget('b')).toHaveLength(0);
  });

  it('removes edge and updates indexes', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'a', type: 'file', name: 'a.ts' });
    builder.addNode({ id: 'b', type: 'function', name: 'b' });
    builder.addEdge('a', 'b', 'contains', 1.0);

    expect(builder.findNeighbors('a')).toHaveLength(1);
    builder.removeEdge('a--contains--b');
    expect(builder.findNeighbors('a')).toHaveLength(0);
  });

  it('removes edges by node efficiently', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'a', type: 'file', name: 'a.ts' });
    builder.addNode({ id: 'b', type: 'function', name: 'b' });
    builder.addNode({ id: 'c', type: 'function', name: 'c' });
    builder.addEdge('a', 'b', 'contains', 1.0);
    builder.addEdge('a', 'c', 'contains', 1.0);
    builder.addEdge('b', 'c', 'calls', 0.8);

    expect(builder.getEdgeCount()).toBe(3);
    const removed = builder.removeEdgesByNode('a');
    expect(removed).toBe(2);
    expect(builder.getEdgeCount()).toBe(1);
    expect(builder.findNeighbors('a')).toHaveLength(0);
    expect(builder.findNeighbors('b')).toHaveLength(1); // b-c edge remains
  });

  it('prevents duplicate edges', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'a', type: 'file', name: 'a.ts' });
    builder.addNode({ id: 'b', type: 'function', name: 'b' });
    builder.addEdge('a', 'b', 'contains', 1.0);
    builder.addEdge('a', 'b', 'contains', 1.0);

    expect(builder.getEdgeCount()).toBe(1);
  });

  it('finds neighbors with bidirectional edges', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'a', type: 'file', name: 'a.ts' });
    builder.addNode({ id: 'b', type: 'function', name: 'b' });
    builder.addNode({ id: 'c', type: 'function', name: 'c' });
    builder.addEdge('a', 'b', 'contains', 1.0);
    builder.addEdge('c', 'a', 'imports', 0.7);

    const neighbors = builder.findNeighbors('a');
    expect(neighbors).toHaveLength(2);
  });

  it('filters neighbors by edge type', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'a', type: 'file', name: 'a.ts' });
    builder.addNode({ id: 'b', type: 'function', name: 'b' });
    builder.addNode({ id: 'c', type: 'function', name: 'c' });
    builder.addEdge('a', 'b', 'contains', 1.0);
    builder.addEdge('a', 'c', 'imports', 0.7);

    const containsNeighbors = builder.findNeighbors('a', 'contains');
    expect(containsNeighbors).toHaveLength(1);
    expect(containsNeighbors[0].id).toBe('b');
  });

  it('handles large graph neighbor queries efficiently', () => {
    const builder = new KnowledgeGraphBuilder();
    const nodeCount = 1000;

    // Create many nodes
    for (let i = 0; i < nodeCount; i++) {
      builder.addNode({ id: `node-${i}`, type: 'function', name: `fn-${i}` });
    }

    // Create edges for node-0 (high degree)
    for (let i = 1; i <= 100; i++) {
      builder.addEdge('node-0', `node-${i}`, 'calls', 0.8);
    }

    // Query neighbors — should be fast with indexes
    const start = performance.now();
    const neighbors = builder.findNeighbors('node-0');
    const duration = performance.now() - start;

    expect(neighbors).toHaveLength(100);
    expect(duration).toBeLessThan(10); // Should be sub-millisecond with indexes
  });
});
