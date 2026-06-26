import { describe, it, expect } from 'vitest';
import { KnowledgeGraphBuilder } from '../src/core/knowledge-graph.js';
import {
  runEnrichers,
  embeddingsEnricher,
  clusterEnricher,
  C_LAYER_ENRICHERS,
  type EnrichContext,
} from '../src/core/graph-enrich.js';
import { TemplateEmbeddingService, type EmbeddingService } from '../src/core/embedding-service.js';
import type { FileFingerprint, GraphEdge, FunctionSignature, ClassSignature } from '../src/core/types.js';

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

function fn(name: string, params: string[]): FunctionSignature {
  return { name, params, isExported: true, startLine: 1, endLine: 2 };
}

function cls(name: string, methods: string[]): ClassSignature {
  return { name, methods, properties: [], isExported: true, startLine: 1, endLine: 2 };
}

/** Edge present in either direction (similarity edges are canonicalized). */
function hasUndirected(edges: GraphEdge[], a: string, type: string, b: string): GraphEdge | undefined {
  return edges.find(
    (e) => e.type === type && ((e.source === a && e.target === b) || (e.source === b && e.target === a))
  );
}

/**
 * Deterministic embedding stub mapping a marker substring → a fixed vector, so
 * cosine values (hence the similar_to/related banding) are exact and testable.
 * Vectors need not be normalized — cosineSimilarity normalizes.
 */
class FakeEmbeddings implements EmbeddingService {
  readonly dimensions = 3;
  constructor(private table: Record<string, number[]>) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      for (const key of Object.keys(this.table)) if (t.includes(key)) return this.table[key];
      return [0, 0, 0];
    });
  }
}

const C: EnrichContext['enabledLayers'] = ['C'];

describe('embeddingsEnricher', () => {
  it('self-skips when no embedding provider is present', async () => {
    const fingerprints = {
      'a.ts': fp({ filePath: 'a.ts', functions: [fn('a', ['VEC1'])] }),
      'b.ts': fp({ filePath: 'b.ts', functions: [fn('b', ['VEC1'])] }),
    };
    const builder = new KnowledgeGraphBuilder();
    await embeddingsEnricher.enrich(builder, fingerprints, { enabledLayers: C });
    expect(builder.build().edges).toHaveLength(0);
  });

  it('is gated by enabledLayers (skipped when C is off)', async () => {
    const fingerprints = {
      'a.ts': fp({ filePath: 'a.ts', functions: [fn('a', ['VEC1'])] }),
      'b.ts': fp({ filePath: 'b.ts', functions: [fn('b', ['VEC1'])] }),
    };
    const builder = new KnowledgeGraphBuilder();
    const ctx: EnrichContext = {
      enabledLayers: ['A', 'B'],
      embeddings: new FakeEmbeddings({ VEC1: [1, 0, 0] }),
    };
    await runEnrichers(builder, fingerprints, ctx, C_LAYER_ENRICHERS);
    expect(builder.build().edges).toHaveLength(0);
  });

  it('bands by cosine: identical → similar_to, mid → related, low → no edge', async () => {
    const fingerprints = {
      'a.ts': fp({ filePath: 'a.ts', functions: [fn('a', ['VEC1'])] }),
      'b.ts': fp({ filePath: 'b.ts', functions: [fn('b', ['VEC1'])] }), // cos(a,b)=1
      'c.ts': fp({ filePath: 'c.ts', functions: [fn('c', ['VEC2'])] }), // cos(a,c)=0.8
      'd.ts': fp({ filePath: 'd.ts', functions: [fn('d', ['VEC3'])] }), // cos(a,d)=0
    };
    const ctx: EnrichContext = {
      enabledLayers: C,
      embeddings: new FakeEmbeddings({
        VEC1: [1, 0, 0],
        VEC2: [0.8, 0.6, 0], // cos with VEC1 = 0.8 → related band
        VEC3: [0, 1, 0], // cos with VEC1 = 0 ; with VEC2 = 0.6 (< 0.70) → no edge
      }),
    };
    const builder = new KnowledgeGraphBuilder();
    await embeddingsEnricher.enrich(builder, fingerprints, ctx);
    const edges = builder.build().edges;

    const ab = hasUndirected(edges, 'function:a.ts:a', 'similar_to', 'function:b.ts:b');
    expect(ab).toBeDefined();
    expect(ab!.weight).toBeCloseTo(1, 6);

    expect(hasUndirected(edges, 'function:a.ts:a', 'related', 'function:c.ts:c')).toBeDefined();
    expect(hasUndirected(edges, 'function:b.ts:b', 'related', 'function:c.ts:c')).toBeDefined();

    // d (VEC3) is below threshold to everything → no edges touch it.
    expect(edges.some((e) => e.source.includes(':d') || e.target.includes(':d'))).toBe(false);
  });

  it('emits a single canonical edge per pair (no i→j and j→i duplicate)', async () => {
    const fingerprints = {
      'a.ts': fp({ filePath: 'a.ts', functions: [fn('a', ['VEC1'])] }),
      'b.ts': fp({ filePath: 'b.ts', functions: [fn('b', ['VEC1'])] }),
    };
    const ctx: EnrichContext = {
      enabledLayers: C,
      embeddings: new FakeEmbeddings({ VEC1: [1, 0, 0] }),
    };
    const builder = new KnowledgeGraphBuilder();
    await embeddingsEnricher.enrich(builder, fingerprints, ctx);
    expect(builder.build().edges).toHaveLength(1);
  });

  it('compares only within a node type (function never linked to class)', async () => {
    const fingerprints = {
      'a.ts': fp({ filePath: 'a.ts', functions: [fn('a', ['VEC1'])], classes: [cls('K', ['VEC1'])] }),
      'b.ts': fp({ filePath: 'b.ts', functions: [fn('b', ['VEC1'])] }),
    };
    const ctx: EnrichContext = {
      enabledLayers: C,
      embeddings: new FakeEmbeddings({ VEC1: [1, 0, 0] }),
    };
    const builder = new KnowledgeGraphBuilder();
    await embeddingsEnricher.enrich(builder, fingerprints, ctx);
    const edges = builder.build().edges;

    // function↔function connects; the lone class is its own group (size 1, skipped).
    expect(hasUndirected(edges, 'function:a.ts:a', 'similar_to', 'function:b.ts:b')).toBeDefined();
    expect(edges.some((e) => e.source.startsWith('class:') || e.target.startsWith('class:'))).toBe(false);
  });

  it('top-K caps density — a complete similar group is pruned below n*(n-1)/2', async () => {
    const fingerprints: Record<string, FileFingerprint> = {};
    for (let i = 0; i < 8; i++) {
      fingerprints[`f${i}.ts`] = fp({ filePath: `f${i}.ts`, functions: [fn(`f${i}`, ['VEC1'])] });
    }
    const ctx: EnrichContext = {
      enabledLayers: C,
      embeddings: new FakeEmbeddings({ VEC1: [1, 0, 0] }), // all identical → complete graph
    };
    const builder = new KnowledgeGraphBuilder();
    await embeddingsEnricher.enrich(builder, fingerprints, ctx);
    const count = builder.build().edges.length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan((8 * 7) / 2); // 28 — pruning happened
  });

  it('smoke: real template stub links identical signatures across files', async () => {
    const sig = ['user', 'password'];
    const fingerprints = {
      'auth/a.ts': fp({ filePath: 'auth/a.ts', functions: [fn('authenticate', sig)] }),
      'auth/b.ts': fp({ filePath: 'auth/b.ts', functions: [fn('authenticate', sig)] }),
    };
    const ctx: EnrichContext = {
      enabledLayers: C,
      embeddings: new TemplateEmbeddingService(),
    };
    const builder = new KnowledgeGraphBuilder();
    await embeddingsEnricher.enrich(builder, fingerprints, ctx);
    expect(
      hasUndirected(builder.build().edges, 'function:auth/a.ts:authenticate', 'similar_to', 'function:auth/b.ts:authenticate')
    ).toBeDefined();
  });
});

describe('clusterEnricher', () => {
  it('groups cross-type members above threshold into one concept node + related edges', async () => {
    const fingerprints = {
      'a.ts': fp({ filePath: 'a.ts', functions: [fn('login', ['VEC1'])] }),
      'b.ts': fp({ filePath: 'b.ts', classes: [cls('Session', ['VEC1'])] }),
    };
    const ctx: EnrichContext = {
      enabledLayers: C,
      embeddings: new FakeEmbeddings({ VEC1: [1, 0, 0] }),
    };
    const builder = new KnowledgeGraphBuilder();
    await clusterEnricher.enrich(builder, fingerprints, ctx);
    const g = builder.build();

    const concept = g.nodes.find((n) => n.type === 'concept');
    expect(concept).toBeDefined();
    expect(concept!.id).toMatch(/^concept:cluster:[0-9a-f]{8}$/);
    expect(concept!.name.length).toBeGreaterThan(0); // placeholder name present

    // A function and a class were pooled into the SAME concept (cross-cutting).
    expect(hasUndirected(g.edges, 'function:a.ts:login', 'related', concept!.id)).toBeDefined();
    expect(hasUndirected(g.edges, 'class:b.ts:Session', 'related', concept!.id)).toBeDefined();
  });

  it('keeps distinct proximity groups as separate concept nodes', async () => {
    const fingerprints = {
      'a.ts': fp({ filePath: 'a.ts', functions: [fn('a', ['VEC1'])] }),
      'b.ts': fp({ filePath: 'b.ts', functions: [fn('b', ['VEC1'])] }),
      'c.ts': fp({ filePath: 'c.ts', functions: [fn('c', ['VEC2'])] }),
      'd.ts': fp({ filePath: 'd.ts', functions: [fn('d', ['VEC2'])] }),
    };
    const ctx: EnrichContext = {
      enabledLayers: C,
      embeddings: new FakeEmbeddings({ VEC1: [1, 0, 0], VEC2: [0, 1, 0] }), // orthogonal
    };
    const builder = new KnowledgeGraphBuilder();
    await clusterEnricher.enrich(builder, fingerprints, ctx);
    const concepts = builder.build().nodes.filter((n) => n.type === 'concept');
    expect(concepts).toHaveLength(2);
  });

  it('drops singleton components (a lone node is not a concept)', async () => {
    const fingerprints = {
      'a.ts': fp({ filePath: 'a.ts', functions: [fn('a', ['VEC1'])] }),
      'b.ts': fp({ filePath: 'b.ts', functions: [fn('b', ['VEC2'])] }),
    };
    const ctx: EnrichContext = {
      enabledLayers: C,
      embeddings: new FakeEmbeddings({ VEC1: [1, 0, 0], VEC2: [0, 1, 0] }),
    };
    const builder = new KnowledgeGraphBuilder();
    await clusterEnricher.enrich(builder, fingerprints, ctx);
    expect(builder.build().nodes.some((n) => n.type === 'concept')).toBe(false);
  });

  it('produces a stable cluster id across runs (deterministic hash)', async () => {
    const fingerprints = {
      'a.ts': fp({ filePath: 'a.ts', functions: [fn('a', ['VEC1'])] }),
      'b.ts': fp({ filePath: 'b.ts', functions: [fn('b', ['VEC1'])] }),
    };
    const ctx: EnrichContext = {
      enabledLayers: C,
      embeddings: new FakeEmbeddings({ VEC1: [1, 0, 0] }),
    };
    const run = async () => {
      const b = new KnowledgeGraphBuilder();
      await clusterEnricher.enrich(b, fingerprints, ctx);
      return b.build().nodes.find((n) => n.type === 'concept')!.id;
    };
    expect(await run()).toBe(await run());
  });

  it('self-skips when no embedding provider is present', async () => {
    const fingerprints = {
      'a.ts': fp({ filePath: 'a.ts', functions: [fn('a', ['VEC1'])] }),
      'b.ts': fp({ filePath: 'b.ts', functions: [fn('b', ['VEC1'])] }),
    };
    const builder = new KnowledgeGraphBuilder();
    await clusterEnricher.enrich(builder, fingerprints, { enabledLayers: C });
    expect(builder.build().nodes.some((n) => n.type === 'concept')).toBe(false);
  });
});
