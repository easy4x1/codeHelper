import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  TemplateEmbeddingService,
  LocalEmbeddingService,
  EmbeddingConfigResolver,
  createEmbeddingService,
  cosineSimilarity,
  EmbeddingCache,
  CachedEmbeddingService,
  type EmbeddingService,
} from '../src/core/embedding-service.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('returns 0 on length mismatch or empty input', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 when either vector is all zeros', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('TemplateEmbeddingService', () => {
  const svc = new TemplateEmbeddingService();

  it('reports its dimensions and emits vectors of that length', async () => {
    expect(svc.dimensions).toBe(256);
    const [vec] = await svc.embed(['hello world']);
    expect(vec).toHaveLength(256);
  });

  it('is deterministic — same text yields identical vectors', async () => {
    const [a] = await svc.embed(['function login(user) -> Session']);
    const [b] = await svc.embed(['function login(user) -> Session']);
    expect(a).toEqual(b);
  });

  it('emits L2-normalized vectors (unit magnitude)', async () => {
    const [vec] = await svc.embed(['some representative source text']);
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(mag).toBeCloseTo(1, 6);
  });

  it('identical texts have cosine ~1, unrelated texts much lower', async () => {
    const [auth1] = await svc.embed(['function authenticate(user, password)']);
    const [auth2] = await svc.embed(['function authenticate(user, password)']);
    const [unrelated] = await svc.embed(['class GeometryRenderer { drawTriangle }']);
    expect(cosineSimilarity(auth1, auth2)).toBeCloseTo(1, 6);
    expect(cosineSimilarity(auth1, unrelated)).toBeLessThan(
      cosineSimilarity(auth1, auth2)
    );
  });

  it('overlapping texts score higher than disjoint ones (banding is meaningful)', async () => {
    const [base] = await svc.embed(['function parseConfig(path) -> Config']);
    const [overlap] = await svc.embed(['function parseConfig(path) -> Settings']);
    const [disjoint] = await svc.embed(['xyzzy quux frobnicate']);
    expect(cosineSimilarity(base, overlap)).toBeGreaterThan(
      cosineSimilarity(base, disjoint)
    );
  });

  it('handles empty text without NaN', async () => {
    const [vec] = await svc.embed(['']);
    expect(vec).toHaveLength(256);
    expect(vec.every((v) => v === 0)).toBe(true);
  });

  it('honors a custom dimension', async () => {
    const small = new TemplateEmbeddingService(64);
    const [vec] = await small.embed(['hello']);
    expect(vec).toHaveLength(64);
  });
});

describe('EmbeddingConfigResolver', () => {
  const resolver = new EmbeddingConfigResolver();

  it('defaults to template when no hint given', () => {
    const r = resolver.resolve();
    expect(r.config.provider).toBe('template');
    expect(r.source).toBe('fallback');
  });

  it('resolves local provider with default model', () => {
    const r = resolver.resolve('local');
    expect(r.config.provider).toBe('local');
    expect(r.config.model).toBe('bge-small-en-v1.5');
  });

  it('maps aliases to canonical providers', () => {
    expect(resolver.resolve('onnx').config.provider).toBe('local');
    expect(resolver.resolve('minilm').config.provider).toBe('local');
    expect(resolver.resolve('unknown-thing').config.provider).toBe('template');
  });

  it('honors a model hint for local', () => {
    const r = resolver.resolve('local', 'all-MiniLM-L6-v2');
    expect(r.config.model).toBe('all-MiniLM-L6-v2');
  });
});

describe('createEmbeddingService', () => {
  it('returns a template service for null or template config', () => {
    expect(createEmbeddingService(null)).toBeInstanceOf(TemplateEmbeddingService);
    expect(
      createEmbeddingService({ provider: 'template', model: 'template' })
    ).toBeInstanceOf(TemplateEmbeddingService);
  });

  it('returns a LocalEmbeddingService for the local provider (lazy — no model load on construct)', () => {
    const svc = createEmbeddingService({ provider: 'local', model: 'bge-small-en-v1.5' });
    expect(svc).toBeInstanceOf(LocalEmbeddingService);
    // Native dimension is reported up front without touching the ONNX model.
    expect(svc.dimensions).toBe(384);
  });

  it('falls back to template stub for not-yet-implemented providers (api)', () => {
    const svc = createEmbeddingService({ provider: 'api', model: 'text-embedding-3-small' });
    expect(svc).toBeInstanceOf(TemplateEmbeddingService);
  });

  it('respects a dimension override', () => {
    const svc = createEmbeddingService({
      provider: 'template',
      model: 'template',
      dimensions: 128,
    });
    expect(svc.dimensions).toBe(128);
  });
});

/** Counts how many texts actually reached the underlying provider. */
class CountingEmbeddings implements EmbeddingService {
  readonly dimensions = 4;
  embedded: string[] = [];
  async embed(texts: string[]): Promise<number[][]> {
    this.embedded.push(...texts);
    // Deterministic distinct vector per text (first char code in slot 0).
    return texts.map((t) => [t.charCodeAt(0) || 0, 1, 0, 0]);
  }
}

describe('EmbeddingCache', () => {
  it('keys vary by model tag, dimension, and text', () => {
    const a = EmbeddingCache.key('bge', 384, 'hello');
    expect(EmbeddingCache.key('bge', 384, 'hello')).toBe(a); // stable
    expect(EmbeddingCache.key('minilm', 384, 'hello')).not.toBe(a); // model differs
    expect(EmbeddingCache.key('bge', 256, 'hello')).not.toBe(a); // dim differs
    expect(EmbeddingCache.key('bge', 384, 'world')).not.toBe(a); // text differs
  });

  it('stores and retrieves a copy (no aliasing)', () => {
    const cache = new EmbeddingCache();
    const vec = [1, 2, 3];
    cache.set('k', vec);
    const got = cache.get('k')!;
    expect(got).toEqual([1, 2, 3]);
    got[0] = 99;
    expect(cache.get('k')![0]).toBe(1); // stored copy untouched
  });

  it('evicts least-recently-used beyond the cap', () => {
    const cache = new EmbeddingCache({ maxEntries: 2 });
    cache.set('a', [1]);
    cache.set('b', [2]);
    cache.get('a'); // bump a → b is now LRU
    cache.set('c', [3]); // evicts b
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('round-trips through export/load', () => {
    const cache = new EmbeddingCache();
    cache.set('x', [0.1, 0.2]);
    cache.set('y', [0.3, 0.4]);
    const restored = new EmbeddingCache();
    restored.load(cache.export());
    expect(restored.size()).toBe(2);
    expect(restored.get('x')).toEqual([0.1, 0.2]);
  });

  it('load(undefined) clears to empty', () => {
    const cache = new EmbeddingCache();
    cache.set('x', [1]);
    cache.load(undefined);
    expect(cache.size()).toBe(0);
  });
});

describe('CachedEmbeddingService', () => {
  it('only sends cache misses to the underlying provider, preserving order', async () => {
    const base = new CountingEmbeddings();
    const cached = new CachedEmbeddingService(base, new EmbeddingCache(), 'test-model');

    const first = await cached.embed(['alpha', 'beta']);
    expect(base.embedded).toEqual(['alpha', 'beta']); // both missed

    const second = await cached.embed(['beta', 'gamma']); // beta hits, gamma misses
    expect(base.embedded).toEqual(['alpha', 'beta', 'gamma']); // only gamma added
    expect(second[0]).toEqual(first[1]); // beta vector served from cache, same value
  });

  it('makes a fully-cached second pass do zero provider work (eliminates double-embed)', async () => {
    const base = new CountingEmbeddings();
    const cache = new EmbeddingCache();
    const cached = new CachedEmbeddingService(base, cache, 'm');
    const texts = ['n1', 'n2', 'n3'];

    await cached.embed(texts); // embeddingsEnricher pass
    const callsAfterFirst = base.embedded.length;
    await cached.embed(texts); // clusterEnricher pass — should be all hits
    expect(base.embedded.length).toBe(callsAfterFirst); // no new provider calls
  });

  it('reports the underlying provider dimensions', () => {
    const cached = new CachedEmbeddingService(new CountingEmbeddings(), new EmbeddingCache(), 'm');
    expect(cached.dimensions).toBe(4);
  });
});

describe('LocalEmbeddingService (construction)', () => {
  it('maps a known short model name to its repo + native dimension', () => {
    const svc = new LocalEmbeddingService({ model: 'bge-small-en-v1.5' });
    expect(svc.dimensions).toBe(384);
  });

  it('honors a full org/model repo id and dimension override', () => {
    const svc = new LocalEmbeddingService({ model: 'my-org/custom-embed', dimensions: 512 });
    expect(svc.dimensions).toBe(512);
  });

  it('defaults to bge-small (384-d) when no model given', () => {
    expect(new LocalEmbeddingService().dimensions).toBe(384);
  });
});

/**
 * DoD eval (docs/GRAPH-ENRICHMENT-PLAN.md §7.8): the template stub is lexical, so
 * a green stub test does NOT prove the C layer is semantically real. This block
 * runs the actual ONNX model and asserts it captures MEANING, not character
 * overlap — the property the stub fundamentally cannot satisfy.
 *
 * Skipped automatically unless the model is pre-downloaded under ./models
 * (see scripts/fetch-embedding-model.sh). On CI/offline machines without the
 * weights it is skipped rather than failed — never silently passed.
 */
const LOCAL_MODEL_DIR = 'models/Xenova/bge-small-en-v1.5';
const LOCAL_MODEL_AVAILABLE = existsSync(
  join(LOCAL_MODEL_DIR, 'onnx', 'model_quantized.onnx')
);

describe.skipIf(!LOCAL_MODEL_AVAILABLE)('LocalEmbeddingService (real ONNX model — DoD eval)', () => {
  const svc = new LocalEmbeddingService({ modelPath: 'models', dtype: 'q8' });

  it('captures SEMANTIC similarity the lexical stub cannot', async () => {
    const [authenticate, login, calculateTax] = await svc.embed([
      'function authenticate(user, password) -> Session',
      'function login(credentials) -> Session',
      'function calculateTax(amount: number) -> number',
    ]);

    const semanticPair = cosineSimilarity(authenticate, login);
    const unrelatedPair = cosineSimilarity(authenticate, calculateTax);

    // authenticate vs login share almost no tokens yet mean the same thing — the
    // real model scores them high and far above an unrelated function.
    expect(semanticPair).toBeGreaterThan(0.8);
    expect(semanticPair).toBeGreaterThan(unrelatedPair + 0.2);

    // The lexical stub genuinely FAILS this pair (little char overlap → low cos),
    // which is exactly why shipping the real model matters.
    const stub = new TemplateEmbeddingService();
    const [sAuth, sLogin] = await stub.embed([
      'function authenticate(user, password) -> Session',
      'function login(credentials) -> Session',
    ]);
    expect(cosineSimilarity(sAuth, sLogin)).toBeLessThan(semanticPair - 0.2);
  }, 60000);

  it('emits L2-normalized 384-d vectors', async () => {
    const [vec] = await svc.embed(['class HttpClient { get post put delete }']);
    expect(vec).toHaveLength(384);
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(mag).toBeCloseTo(1, 4);
  }, 60000);
});
