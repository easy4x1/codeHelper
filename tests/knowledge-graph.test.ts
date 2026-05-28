import { describe, it, expect } from 'vitest';
import { KnowledgeGraphBuilder } from '../src/core/knowledge-graph.js';
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
});
