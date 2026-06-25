import { describe, it, expect } from 'vitest';
import { buildGraphFromFingerprints } from '../src/core/graph-build.js';
import type { FileFingerprint, GraphEdge } from '../src/core/types.js';

function fp(partial: Partial<FileFingerprint> & { filePath: string }): FileFingerprint {
  return {
    contentHash: 'h',
    functions: [],
    classes: [],
    imports: [],
    exports: [],
    totalLines: 1,
    hasStructuralAnalysis: true,
    ...partial,
  };
}

function hasEdge(edges: GraphEdge[], source: string, type: string, target: string): boolean {
  return edges.some(e => e.source === source && e.type === type && e.target === target);
}

describe('buildGraphFromFingerprints', () => {
  it('builds contains edges from file to its functions and classes', () => {
    const graph = buildGraphFromFingerprints({
      'a.ts': fp({
        filePath: 'a.ts',
        functions: [{ name: 'foo', params: [], isExported: true, startLine: 1, endLine: 2 }],
        classes: [{ name: 'Bar', methods: [], properties: [], isExported: true, startLine: 3, endLine: 4 }],
      }),
    });

    expect(hasEdge(graph.edges, 'file:a.ts', 'contains', 'function:a.ts:foo')).toBe(true);
    expect(hasEdge(graph.edges, 'file:a.ts', 'contains', 'class:a.ts:Bar')).toBe(true);
  });

  it('builds calls edges between functions in the same file', () => {
    const graph = buildGraphFromFingerprints({
      'a.ts': fp({
        filePath: 'a.ts',
        functions: [
          { name: 'caller', params: [], isExported: true, startLine: 1, endLine: 3, calls: ['callee'] },
          { name: 'callee', params: [], isExported: false, startLine: 4, endLine: 5 },
        ],
      }),
    });

    expect(hasEdge(graph.edges, 'function:a.ts:caller', 'calls', 'function:a.ts:callee')).toBe(true);
  });

  it('builds cross-file calls edges through resolved relative imports', () => {
    const graph = buildGraphFromFingerprints({
      'src/a.ts': fp({
        filePath: 'src/a.ts',
        functions: [{ name: 'caller', params: [], isExported: true, startLine: 1, endLine: 3, calls: ['helper'] }],
        imports: [{ source: './b.js', items: ['helper'], line: 1 }],
      }),
      'src/b.ts': fp({
        filePath: 'src/b.ts',
        functions: [{ name: 'helper', params: [], isExported: true, startLine: 1, endLine: 2 }],
      }),
    });

    expect(hasEdge(graph.edges, 'function:src/a.ts:caller', 'calls', 'function:src/b.ts:helper')).toBe(true);
  });

  it('builds inherits edges between a class and its resolved superclass', () => {
    const graph = buildGraphFromFingerprints({
      'src/child.ts': fp({
        filePath: 'src/child.ts',
        classes: [{ name: 'Child', methods: [], properties: [], isExported: true, startLine: 1, endLine: 2, superClass: 'Base' }],
        imports: [{ source: './base.js', items: ['Base'], line: 1 }],
      }),
      'src/base.ts': fp({
        filePath: 'src/base.ts',
        classes: [{ name: 'Base', methods: [], properties: [], isExported: true, startLine: 1, endLine: 2 }],
      }),
    });

    expect(hasEdge(graph.edges, 'class:src/child.ts:Child', 'inherits', 'class:src/base.ts:Base')).toBe(true);
  });

  it('links local imports to specific symbol nodes, not just a coarse module node', () => {
    const graph = buildGraphFromFingerprints({
      'src/a.ts': fp({
        filePath: 'src/a.ts',
        imports: [{ source: './b.js', items: ['helper'], line: 1 }],
      }),
      'src/b.ts': fp({
        filePath: 'src/b.ts',
        functions: [{ name: 'helper', params: [], isExported: true, startLine: 1, endLine: 2 }],
      }),
    });

    // Fine-grained: edge reaches the specific exported symbol
    expect(hasEdge(graph.edges, 'file:src/a.ts', 'imports', 'function:src/b.ts:helper')).toBe(true);
    // And does NOT fabricate a coarse module node for a resolved local file
    expect(graph.nodes.some(n => n.id === 'module:./b.js')).toBe(false);
  });

  it('keeps a coarse module node for external (non-relative) imports', () => {
    const graph = buildGraphFromFingerprints({
      'src/a.ts': fp({
        filePath: 'src/a.ts',
        imports: [{ source: 'lodash', items: ['map'], line: 1 }],
      }),
    });

    expect(graph.nodes.some(n => n.id === 'module:lodash')).toBe(true);
    expect(hasEdge(graph.edges, 'file:src/a.ts', 'imports', 'module:lodash')).toBe(true);
  });
});
