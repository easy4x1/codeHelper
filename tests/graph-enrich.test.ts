import { describe, it, expect } from 'vitest';
import { KnowledgeGraphBuilder } from '../src/core/knowledge-graph.js';
import { addFileToGraph } from '../src/core/graph-build.js';
import {
  runEnrichers,
  A_LAYER_ENRICHERS,
  implementsEnricher,
  testedByEnricher,
  dependsOnEnricher,
  fileClassifierEnricher,
  type GraphEnricher,
  type EnrichContext,
} from '../src/core/graph-enrich.js';
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

/** Build the deterministic core graph builder from fingerprints (mirrors init). */
function coreBuilder(fingerprints: Record<string, FileFingerprint>): KnowledgeGraphBuilder {
  const builder = new KnowledgeGraphBuilder();
  const knownPaths = new Set(Object.keys(fingerprints));
  for (const [filePath, f] of Object.entries(fingerprints)) {
    addFileToGraph(builder, filePath, f, fingerprints, knownPaths);
  }
  return builder;
}

describe('runEnrichers', () => {
  it('runs only enrichers whose layer is enabled', async () => {
    const ran: string[] = [];
    const mk = (name: string, layer: GraphEnricher['layer']): GraphEnricher => ({
      name,
      layer,
      enrich: async () => {
        ran.push(name);
      },
    });
    const builder = new KnowledgeGraphBuilder();
    const ctx: EnrichContext = { enabledLayers: ['A'] };

    await runEnrichers(builder, {}, ctx, [mk('a-one', 'A'), mk('d-one', 'D'), mk('a-two', 'A')]);

    expect(ran).toEqual(['a-one', 'a-two']);
  });
});

describe('implementsEnricher', () => {
  it('links a class to an interface-class it implements within the same file', async () => {
    const fingerprints = {
      'a.ts': fp({
        filePath: 'a.ts',
        classes: [
          { name: 'Runnable', methods: [], properties: [], isExported: true, startLine: 1, endLine: 2 },
          { name: 'Worker', methods: [], properties: [], isExported: true, startLine: 3, endLine: 4, implements: ['Runnable'] },
        ],
      }),
    };
    const builder = coreBuilder(fingerprints);

    await implementsEnricher.enrich(builder, fingerprints, { enabledLayers: ['A'] });

    expect(hasEdge(builder.build().edges, 'class:a.ts:Worker', 'implements', 'class:a.ts:Runnable')).toBe(true);
  });

  it('links a class to a cross-file implemented class through a relative import', async () => {
    const fingerprints = {
      'src/worker.ts': fp({
        filePath: 'src/worker.ts',
        classes: [{ name: 'Worker', methods: [], properties: [], isExported: true, startLine: 1, endLine: 2, implements: ['Runnable'] }],
        imports: [{ source: './contracts.js', items: ['Runnable'], line: 1 }],
      }),
      'src/contracts.ts': fp({
        filePath: 'src/contracts.ts',
        classes: [{ name: 'Runnable', methods: [], properties: [], isExported: true, startLine: 1, endLine: 2 }],
      }),
    };
    const builder = coreBuilder(fingerprints);

    await implementsEnricher.enrich(builder, fingerprints, { enabledLayers: ['A'] });

    expect(hasEdge(builder.build().edges, 'class:src/worker.ts:Worker', 'implements', 'class:src/contracts.ts:Runnable')).toBe(true);
  });
});

describe('testedByEnricher', () => {
  it('links a source file to a test file that imports it', async () => {
    const fingerprints = {
      'src/calc.ts': fp({ filePath: 'src/calc.ts', functions: [{ name: 'add', params: [], isExported: true, startLine: 1, endLine: 2 }] }),
      'tests/calc.test.ts': fp({
        filePath: 'tests/calc.test.ts',
        imports: [{ source: '../src/calc.js', items: ['add'], line: 1 }],
      }),
    };
    const builder = coreBuilder(fingerprints);

    await testedByEnricher.enrich(builder, fingerprints, { enabledLayers: ['A'] });

    expect(hasEdge(builder.build().edges, 'file:src/calc.ts', 'tested_by', 'file:tests/calc.test.ts')).toBe(true);
  });

  it('does not create tested_by edges for non-test importers', async () => {
    const fingerprints = {
      'src/calc.ts': fp({ filePath: 'src/calc.ts', functions: [{ name: 'add', params: [], isExported: true, startLine: 1, endLine: 2 }] }),
      'src/app.ts': fp({ filePath: 'src/app.ts', imports: [{ source: './calc.js', items: ['add'], line: 1 }] }),
    };
    const builder = coreBuilder(fingerprints);

    await testedByEnricher.enrich(builder, fingerprints, { enabledLayers: ['A'] });

    expect(builder.build().edges.some(e => e.type === 'tested_by')).toBe(false);
  });
});

describe('dependsOnEnricher', () => {
  it('aggregates a file-level depends_on edge for a resolved relative import', async () => {
    const fingerprints = {
      'src/a.ts': fp({
        filePath: 'src/a.ts',
        imports: [{ source: './b.js', items: ['helper'], line: 1 }],
      }),
      'src/b.ts': fp({ filePath: 'src/b.ts', functions: [{ name: 'helper', params: [], isExported: true, startLine: 1, endLine: 2 }] }),
    };
    const builder = coreBuilder(fingerprints);

    await dependsOnEnricher.enrich(builder, fingerprints, { enabledLayers: ['A'] });

    expect(hasEdge(builder.build().edges, 'file:src/a.ts', 'depends_on', 'file:src/b.ts')).toBe(true);
  });

  it('aggregates a depends_on edge to a module node for an external import', async () => {
    const fingerprints = {
      'src/a.ts': fp({ filePath: 'src/a.ts', imports: [{ source: 'lodash', items: ['map'], line: 1 }] }),
    };
    const builder = coreBuilder(fingerprints);

    await dependsOnEnricher.enrich(builder, fingerprints, { enabledLayers: ['A'] });

    expect(hasEdge(builder.build().edges, 'file:src/a.ts', 'depends_on', 'module:lodash')).toBe(true);
  });
});

describe('fileClassifierEnricher', () => {
  it('classifies asset files into typed nodes', async () => {
    const builder = new KnowledgeGraphBuilder();
    const ctx: EnrichContext = {
      enabledLayers: ['A'],
      assetFiles: [
        'package.json',
        'README.md',
        '.github/workflows/ci.yml',
        'Dockerfile',
        'prisma/schema.prisma',
        'db/migrations/001_init.sql',
      ],
    };

    await fileClassifierEnricher.enrich(builder, {}, ctx);

    const nodes = builder.build().nodes;
    const nodeOf = (id: string) => nodes.find(n => n.id === id);
    expect(nodeOf('config:package.json')?.type).toBe('config');
    expect(nodeOf('document:README.md')?.type).toBe('document');
    expect(nodeOf('pipeline:.github/workflows/ci.yml')?.type).toBe('pipeline');
    expect(nodeOf('service:Dockerfile')?.type).toBe('service');
    expect(nodeOf('schema:prisma/schema.prisma')?.type).toBe('schema');
    expect(nodeOf('schema:db/migrations/001_init.sql')?.type).toBe('schema');
  });

  it('ignores unclassifiable files and is a no-op without assetFiles', async () => {
    const builder = new KnowledgeGraphBuilder();
    await fileClassifierEnricher.enrich(builder, {}, { enabledLayers: ['A'], assetFiles: ['notes.txt', 'image.png'] });
    expect(builder.build().nodes).toHaveLength(0);

    await fileClassifierEnricher.enrich(builder, {}, { enabledLayers: ['A'] });
    expect(builder.build().nodes).toHaveLength(0);
  });
});

describe('A_LAYER_ENRICHERS registry', () => {
  it('contains the four A-layer enrichers, all tagged layer A', () => {
    const names = A_LAYER_ENRICHERS.map(e => e.name).sort();
    expect(names).toEqual(['depends_on', 'file_classifier', 'implements', 'tested_by']);
    expect(A_LAYER_ENRICHERS.every(e => e.layer === 'A')).toBe(true);
  });
});
