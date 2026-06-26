import { join } from 'path';
import { homedir } from 'os';
import { readFileSync, existsSync } from 'fs';
import { createHash } from '../utils/hash.js';
import { createLogger } from '../utils/logger.js';
import type { EmbeddingCacheEntry } from './types.js';

const logger = createLogger('embedding');

/**
 * Embedding service abstraction (C-layer graph enrichment).
 *
 * Mirrors `LlmService` / `LlmConfigResolver`: one interface, multiple providers,
 * resolved from secure layered config. Vectors are L2-normalized so cosine
 * similarity reduces to a dot product (see {@link cosineSimilarity}).
 *
 *   - `TemplateEmbeddingService` — deterministic char-trigram hash vectors, zero
 *     dependency. Wires the whole C-layer pipeline (enricher / cache / threshold
 *     banding) so it is testable WITHOUT a real model.
 *   - `LocalEmbeddingService` — real ONNX model via transformers.js (default
 *     `bge-small-en-v1.5`, 384-d), zero token. Optional dep, lazy-loaded.
 *   - `ApiEmbeddingService` — OpenAI/Voyage/Cohere, has token cost. Not yet built.
 *
 * ⚠️ Definition-of-Done: the template stub makes tests green but its
 * "similarity" is structural overlap, not semantics. C-layer "done" requires a
 * real-model eval — see scripts/eval-embeddings.mjs and
 * docs/GRAPH-ENRICHMENT-PLAN.md §7.8.
 */
export interface EmbeddingService {
  /** Vector length this provider emits; reported so callers stay model-agnostic. */
  readonly dimensions: number;
  /** Embed a batch of texts, returning one L2-normalized vector per input. */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Cosine similarity of two equal-length vectors. For L2-normalized inputs (what
 * every {@link EmbeddingService} emits) this equals the dot product; we still
 * divide by magnitudes to stay correct if a caller passes un-normalized data.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** L2-normalize a vector in place and return it (zero vector stays zero). */
function normalize(vec: number[]): number[] {
  let mag = 0;
  for (const v of vec) mag += v * v;
  if (mag === 0) return vec;
  const inv = 1 / Math.sqrt(mag);
  for (let i = 0; i < vec.length; i++) vec[i] *= inv;
  return vec;
}

/** FNV-1a 32-bit hash — cheap, deterministic, good enough to bucket n-grams. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic stub embedding: hash each char-trigram of the normalized text
 * into a fixed-width bag-of-features, then L2-normalize. Texts sharing trigrams
 * get correlated vectors (identical text → cosine 1), so the C-layer's threshold
 * banding and clustering are exercisable without a real model — but the
 * "similarity" is lexical overlap, NOT meaning. Never ship this as the real C layer.
 */
export class TemplateEmbeddingService implements EmbeddingService {
  readonly dimensions: number;

  constructor(dimensions = 256) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (normalized.length === 0) return vec;
    // Pad so short strings still yield at least one trigram.
    const padded = `  ${normalized}  `;
    for (let i = 0; i + 3 <= padded.length; i++) {
      const trigram = padded.slice(i, i + 3);
      vec[fnv1a(trigram) % this.dimensions] += 1;
    }
    return normalize(vec);
  }
}

// ============================================
// Config resolution (mirrors LlmConfigResolver)
// ============================================

/** Supported embedding providers. */
export type EmbeddingProvider = 'template' | 'local' | 'api';

export interface EmbeddingProviderConfig {
  provider: EmbeddingProvider;
  /** Local: ONNX model id (e.g. bge-small-en-v1.5). Api: provider model id. */
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** Optional dimension override (else the provider's native size is used). */
  dimensions?: number;
  /** Local: directory of a pre-downloaded/mirror-prefetched model (offline use). */
  modelPath?: string;
  /** Local: ONNX quantization dtype passed to transformers.js (default `q8`). */
  dtype?: string;
}

/** Default model per provider. */
const DEFAULT_EMBEDDING_MODELS: Record<EmbeddingProvider, string> = {
  template: 'template',
  local: 'bge-small-en-v1.5',
  api: 'text-embedding-3-small',
};

/** Map user-facing aliases to canonical provider names. */
const EMBEDDING_PROVIDER_ALIASES: Record<string, EmbeddingProvider> = {
  template: 'template',
  local: 'local',
  onnx: 'local',
  minilm: 'local',
  bge: 'local',
  api: 'api',
  openai: 'api',
  voyage: 'api',
  cohere: 'api',
};

export interface ResolvedEmbeddingConfig {
  config: EmbeddingProviderConfig;
  source: 'environment' | 'user-config' | 'fallback';
}

/**
 * Resolve embedding configuration from secure layered sources, mirroring
 * `LlmConfigResolver`. Local/template providers need no key; only `api` consults
 * env / user config for a key (and yields the template fallback when absent).
 */
export class EmbeddingConfigResolver {
  private userConfigPath = join(homedir(), '.code-agent', 'config.yaml');

  resolve(providerHint?: string, modelHint?: string): ResolvedEmbeddingConfig {
    const provider = this.normalizeProvider(providerHint);

    if (provider === 'template') {
      return {
        config: { provider: 'template', model: 'template' },
        source: 'fallback',
      };
    }

    if (provider === 'local') {
      return {
        config: {
          provider: 'local',
          model: modelHint ?? DEFAULT_EMBEDDING_MODELS.local,
          // Optional offline/mirror hints from the environment (restricted networks).
          modelPath: process.env.EMBEDDING_MODEL_PATH?.trim() || undefined,
          baseUrl: process.env.HF_ENDPOINT?.trim() || undefined,
          dtype: process.env.EMBEDDING_DTYPE?.trim() || undefined,
        },
        source: 'user-config',
      };
    }

    // api — needs a key
    const envKey = process.env.OPENAI_API_KEY?.trim() ?? process.env.VOYAGE_API_KEY?.trim();
    if (envKey) {
      logger.info('Using embedding API key from environment');
      return {
        config: {
          provider: 'api',
          model: modelHint ?? DEFAULT_EMBEDDING_MODELS.api,
          apiKey: envKey,
          baseUrl: process.env.OPENAI_BASE_URL?.trim(),
        },
        source: 'environment',
      };
    }
    const userKey = this.readUserConfigValue('embedding', 'apiKey');
    if (userKey) {
      logger.info('Using embedding API key from user config');
      return {
        config: {
          provider: 'api',
          model: modelHint ?? DEFAULT_EMBEDDING_MODELS.api,
          apiKey: userKey,
        },
        source: 'user-config',
      };
    }

    logger.warn('No embedding API key found — falling back to template stub');
    return {
      config: { provider: 'template', model: 'template' },
      source: 'fallback',
    };
  }

  private normalizeProvider(hint?: string): EmbeddingProvider {
    if (!hint) return 'template';
    return EMBEDDING_PROVIDER_ALIASES[hint.toLowerCase()] ?? 'template';
  }

  /** Read a single value from user config YAML by section + key. */
  private readUserConfigValue(section: string, key: string): string | undefined {
    try {
      if (!existsSync(this.userConfigPath)) return undefined;
      const content = readFileSync(this.userConfigPath, 'utf-8');
      const blockRegex = new RegExp(`^${section}:\\s*$\\n((?:\\s+\\S+:.+\\n?)*)`, 'im');
      const blockMatch = content.match(blockRegex);
      if (!blockMatch) return undefined;
      const keyRegex = new RegExp(`^\\s+${key}:\\s*(.+)$`, 'im');
      const keyMatch = blockMatch[1].match(keyRegex);
      return keyMatch?.[1]?.trim().replace(/^['"]|['"]$/g, '');
    } catch {
      return undefined;
    }
  }
}

/**
 * Build an `EmbeddingService` from resolved config.
 *
 *   - `template` / null  → deterministic char-trigram stub (zero dependency).
 *   - `local`            → {@link LocalEmbeddingService} (real ONNX model, zero token).
 *   - `api`              → not implemented yet; resolves to the template stub with an
 *                          explicit warning (project no-silent-caps rule).
 *
 * `local` construction is cheap — the ONNX model is lazy-loaded on the first
 * `embed()` call, so wiring a `LocalEmbeddingService` never blocks or downloads
 * until something is actually embedded.
 */
export function createEmbeddingService(
  config: EmbeddingProviderConfig | null
): EmbeddingService {
  if (!config || config.provider === 'template') {
    return new TemplateEmbeddingService(config?.dimensions);
  }
  if (config.provider === 'local') {
    return new LocalEmbeddingService({
      model: config.model,
      dimensions: config.dimensions,
      modelPath: config.modelPath,
      host: config.baseUrl,
      dtype: config.dtype,
    });
  }
  logger.warn(
    `Embedding provider "${config.provider}" (model ${config.model}) is not implemented yet ` +
      `— using template stub. (Local ONNX provider is available via provider "local".)`
  );
  return new TemplateEmbeddingService(config.dimensions);
}

// ============================================
// Local ONNX provider (transformers.js, zero token)
// ============================================

/** Module specifier for the optional ONNX runtime; kept as a `string`-typed
 * variable so TypeScript treats the dynamic import as `Promise<any>` and the
 * build never hard-depends on the optional package being present. */
const TRANSFORMERS_MODULE: string = '@huggingface/transformers';

/** Known short model name → HF ONNX repo id + native output dimension. A model
 * containing `/` is treated as a full repo id verbatim. */
const ONNX_MODEL_REPOS: Record<string, { repo: string; dimensions: number }> = {
  'bge-small-en-v1.5': { repo: 'Xenova/bge-small-en-v1.5', dimensions: 384 },
  'all-MiniLM-L6-v2': { repo: 'Xenova/all-MiniLM-L6-v2', dimensions: 384 },
  'jina-embeddings-v2-base-code': {
    repo: 'Xenova/jina-embeddings-v2-base-code',
    dimensions: 768,
  },
};

/** Default directory `scripts/fetch-embedding-model.sh` downloads into, and the
 * directory `LocalEmbeddingService` auto-detects so a fresh clone works offline
 * with no env var: run the fetch script once, then `--embeddings local` just works. */
const DEFAULT_LOCAL_MODELS_DIR = 'models';

export interface LocalEmbeddingOptions {
  /** HF repo id or short model name (mapped via {@link ONNX_MODEL_REPOS}). */
  model?: string;
  /** Expected output dimension; verified against the model on first embed. */
  dimensions?: number;
  /** Directory of a pre-downloaded model (offline / mirror-prefetched). */
  modelPath?: string;
  /** Remote mirror host (e.g. https://hf-mirror.com) when HF hub is unreachable. */
  host?: string;
  /** ONNX quantization dtype (default `q8` — the ~34MB quantized weights). */
  dtype?: string;
}

/**
 * Real embedding provider: runs an ONNX sentence-transformer locally via
 * transformers.js (zero token, no network once the model is cached). Default
 * model `bge-small-en-v1.5` (384-d). Mean-pooled + L2-normalized so cosine is a
 * dot product, matching the rest of the C-layer pipeline.
 *
 * Unlike {@link TemplateEmbeddingService} (lexical overlap), this captures
 * *meaning*: `getUserById` and `fetchUser` score ~0.88 despite sharing almost no
 * characters — which is what makes `similar_to`/`related` edges semantically
 * real. See docs/GRAPH-ENRICHMENT-PLAN.md §7.8 (DoD) and scripts/eval-embeddings.mjs.
 *
 * `@huggingface/transformers` is an OPTIONAL dependency loaded lazily; if it is
 * absent the first `embed()` throws an actionable install error rather than
 * breaking the build/tests.
 */
export class LocalEmbeddingService implements EmbeddingService {
  readonly dimensions: number;
  private readonly repo: string;
  private readonly dtype: string;
  private readonly modelPath?: string;
  private readonly host?: string;
  /** Memoized pipeline; the model is loaded exactly once, on first embed. */
  private extractorPromise: Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>> | null = null;

  constructor(options: LocalEmbeddingOptions = {}) {
    const name = options.model ?? 'bge-small-en-v1.5';
    const known = ONNX_MODEL_REPOS[name];
    this.repo = name.includes('/') ? name : known?.repo ?? name;
    this.dimensions = options.dimensions ?? known?.dimensions ?? 384;
    this.dtype = options.dtype ?? process.env.EMBEDDING_DTYPE?.trim() ?? 'q8';
    this.modelPath = options.modelPath ?? process.env.EMBEDDING_MODEL_PATH?.trim() ?? undefined;
    this.host = options.host ?? process.env.HF_ENDPOINT?.trim() ?? undefined;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getExtractor();
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    const rows = output.tolist();
    if (rows[0] && rows[0].length !== this.dimensions) {
      logger.warn(
        `Local model emitted ${rows[0].length}-d vectors but ${this.dimensions} was expected ` +
          `— cache keys assume ${this.dimensions}; set dimensions to match the model.`
      );
    }
    return rows;
  }

  private getExtractor(): Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>> {
    if (!this.extractorPromise) this.extractorPromise = this.load();
    return this.extractorPromise;
  }

  private async load(): Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>> {
    let transformers: { pipeline: Function; env: Record<string, unknown> };
    try {
      transformers = (await import(TRANSFORMERS_MODULE)) as typeof transformers;
    } catch (err) {
      throw new Error(
        `Local embedding provider needs the optional dependency "@huggingface/transformers". ` +
          `Install it with:  npm install @huggingface/transformers\n` +
          `Original error: ${(err as Error).message}`
      );
    }
    const { pipeline, env } = transformers;
    // Resolve where to load from, in priority order:
    //   1. explicit modelPath (option or EMBEDDING_MODEL_PATH)
    //   2. auto-detected ./models/<repo> (what fetch-embedding-model.sh populates)
    //   3. remote hub (optionally via a mirror host for restricted networks)
    // (1)/(2) pin to local-only so a prefetched model never triggers a download.
    const localPath = this.modelPath ?? this.autoDetectLocalModels();
    if (localPath) {
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      env.localModelPath = localPath;
    }
    if (this.host) env.remoteHost = this.host;
    logger.info(
      `Loading local embedding model "${this.repo}" (dtype=${this.dtype})` +
        (localPath ? ` from ${localPath}` : this.host ? ` via ${this.host}` : '')
    );
    return (await pipeline('feature-extraction', this.repo, { dtype: this.dtype })) as Awaited<
      ReturnType<LocalEmbeddingService['load']>
    >;
  }

  /** Return `DEFAULT_LOCAL_MODELS_DIR` if a prefetched copy of this model lives
   * there (detected by its config.json), else undefined — so machines WITH hub
   * access still download normally. */
  private autoDetectLocalModels(): string | undefined {
    return existsSync(join(DEFAULT_LOCAL_MODELS_DIR, this.repo, 'config.json'))
      ? DEFAULT_LOCAL_MODELS_DIR
      : undefined;
  }
}

// ============================================
// Caching (fingerprint-keyed, persisted via MemoryMiddleware)
// ============================================

/**
 * EmbeddingCache — caches vectors keyed by `<modelTag>:<dim>:<textHash>`.
 *
 * Keying by the embedded TEXT's hash (not file path) means: identical signatures
 * across files share one entry; a model swap invalidates (model tag differs); and
 * on `sync`, unchanged files produce identical node text → identical key → a hit,
 * so re-embedding is skipped. Cosmetic-only edits that leave the signature text
 * untouched also hit. Entries persist via MemoryMiddleware (export/load) and are
 * LRU-capped, mirroring `ResultCache`.
 */
export class EmbeddingCache {
  private store = new Map<string, number[]>();
  private readonly maxEntries: number;

  constructor(options?: { maxEntries?: number }) {
    this.maxEntries = options?.maxEntries ?? 5000;
  }

  /** Build the cache key for a text under a given model tag + dimension. */
  static key(modelTag: string, dimensions: number, text: string): string {
    return `${modelTag}:${dimensions}:${createHash(text)}`;
  }

  /** Retrieve a cached vector (copy), bumping its recency. */
  get(key: string): number[] | undefined {
    const vec = this.store.get(key);
    if (!vec) return undefined;
    this.store.delete(key);
    this.store.set(key, vec);
    return [...vec];
  }

  /** Store a vector (copy), evicting the LRU entry beyond the cap. */
  set(key: string, vector: number[]): void {
    this.store.delete(key);
    this.store.set(key, [...vector]);
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /** Export entries for persistence (deep-copied, oldest-first). */
  export(): EmbeddingCacheEntry[] {
    const entries: EmbeddingCacheEntry[] = [];
    for (const [key, vector] of this.store) entries.push({ key, vector: [...vector] });
    return entries;
  }

  /** Replace entries from persisted storage (capped). */
  load(entries: EmbeddingCacheEntry[] | undefined): void {
    this.store.clear();
    if (!entries) return;
    for (const e of entries) this.store.set(e.key, [...e.vector]);
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

/**
 * Decorates an `EmbeddingService` with an {@link EmbeddingCache}: only cache
 * misses reach the underlying provider, results are written back, and order is
 * preserved. Because both C-layer enrichers embed the same node texts, wrapping
 * the provider once makes the second pass (clustering) free.
 */
export class CachedEmbeddingService implements EmbeddingService {
  readonly dimensions: number;

  constructor(
    private base: EmbeddingService,
    private cache: EmbeddingCache,
    private modelTag: string
  ) {
    this.dimensions = base.dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out = new Array<number[]>(texts.length);
    const missIdx: number[] = [];
    const missTexts: string[] = [];

    texts.forEach((text, i) => {
      const hit = this.cache.get(EmbeddingCache.key(this.modelTag, this.dimensions, text));
      if (hit) {
        out[i] = hit;
      } else {
        missIdx.push(i);
        missTexts.push(text);
      }
    });

    if (missTexts.length > 0) {
      const vectors = await this.base.embed(missTexts);
      vectors.forEach((vec, k) => {
        out[missIdx[k]] = vec;
        this.cache.set(EmbeddingCache.key(this.modelTag, this.dimensions, missTexts[k]), vec);
      });
      logger.info(
        `Embedded ${missTexts.length} miss(es), ${texts.length - missTexts.length} cache hit(s)`
      );
    }

    return out;
  }
}
