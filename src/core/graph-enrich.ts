import { KnowledgeGraphBuilder } from './knowledge-graph.js';
import { resolveImportPath } from './graph-build.js';
import { cosineSimilarity, type EmbeddingService } from './embedding-service.js';
import { createHash } from '../utils/hash.js';
import { createLogger } from '../utils/logger.js';
import type { LlmService } from './llm-service.js';
import { LlmSemanticCache } from './llm-semantic-cache.js';
import type {
  FileFingerprint,
  GraphNode,
  NodeSummaryResult,
  ConceptNameResult,
  ArchitectureLayerResult,
  SemanticEdgesResult,
} from './types.js';

const logger = createLogger('graph-enrich');

/** Max functions referenced in one D-layer semantic-edge LLM batch. */
const MAX_SEMANTIC_FUNCS_PER_BATCH = 15;
/** Max candidate pairs in one D-layer semantic-edge LLM batch. */
const MAX_SEMANTIC_PAIRS_PER_BATCH = 25;

/**
 * Graph enrichment pipeline.
 *
 * `buildGraphFromFingerprints` is the deterministic core (file/function/class/
 * module nodes + contains/imports/exports/calls/inherits edges). Enrichers add
 * the remaining graph semantics in pluggable, separately-testable, layer-gated
 * stages (see docs/GRAPH-ENRICHMENT-PLAN.md):
 *
 *   A — deterministic static (Tree-sitter / fingerprints, zero token)
 *   B — framework-aware static (zero token, enabled per tech stack)
 *   C — embedding similarity (zero token, needs an EmbeddingService)
 *   D — LLM semantics (needs a real LlmService for quality)
 *
 * This module implements the A layer: `implements` / `tested_by` / `depends_on`
 * edges and `config`/`document`/`pipeline`/`service`/`schema` classifier nodes.
 */

export type EnrichLayer = 'A' | 'B' | 'C' | 'D';

export interface EnrichContext {
  /** Which layers to run; an enricher is skipped if its layer is not listed. */
  enabledLayers: EnrichLayer[];
  /**
   * Non-source files (package.json, *.md, Dockerfile, .github/workflows/*, *.sql,
   * schema.prisma, …) for the classifier. Source files come from `fingerprints`.
   */
  assetFiles?: string[];
  /**
   * Raw file content keyed by file path, for B-layer pattern extraction
   * (routes/events/middleware/data-access need call arguments the fingerprint
   * does not capture; table extraction needs `.prisma`/`.sql` content). Holds
   * source files plus schema asset files; absent → B enrichers self-skip.
   */
  sources?: Record<string, string>;
  /** D-layer dependency; absent → D enrichers self-skip. */
  llm?: LlmService;
  /** D-layer result cache; absent → LLM calls are not cached. */
  llmCache?: LlmSemanticCache;
  /** C-layer dependency; absent → C enrichers self-skip. */
  embeddings?: EmbeddingService;
}

export interface GraphEnricher {
  readonly name: string;
  readonly layer: EnrichLayer;
  enrich(
    builder: KnowledgeGraphBuilder,
    fingerprints: Record<string, FileFingerprint>,
    ctx: EnrichContext
  ): void | Promise<void>;
}

/**
 * Run the given enrichers in order, skipping any whose layer is not enabled.
 */
export async function runEnrichers(
  builder: KnowledgeGraphBuilder,
  fingerprints: Record<string, FileFingerprint>,
  ctx: EnrichContext,
  enrichers: GraphEnricher[]
): Promise<void> {
  for (const enricher of enrichers) {
    if (!ctx.enabledLayers.includes(enricher.layer)) continue;
    await enricher.enrich(builder, fingerprints, ctx);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Map each imported symbol name to the concrete source file it resolves to,
 * for a single importer file. External (non-relative) imports are excluded.
 * Mirrors the resolution `addFileToGraph` performs for calls/inherits.
 */
function importedSymbolFiles(
  fp: FileFingerprint,
  knownPaths: Set<string>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const imp of fp.imports) {
    const resolved = resolveImportPath(fp.filePath, imp.source, knownPaths);
    if (!resolved) continue;
    for (const rawItem of imp.items) {
      const item = rawItem.replace(/^\*\s+as\s+/, '');
      map.set(item, resolved);
    }
  }
  return map;
}

const TEST_FILE_PATTERN = /(\.|_)(test|spec)\.[cm]?[jt]sx?$/i;
function isTestFile(filePath: string): boolean {
  return (
    TEST_FILE_PATTERN.test(filePath) ||
    filePath.includes('__tests__/') ||
    /(^|\/)tests?\//.test(filePath)
  );
}

// ---------------------------------------------------------------------------
// A-layer enrichers
// ---------------------------------------------------------------------------

/**
 * `implements` — class → implemented type, resolved like `inherits`: to a class
 * node in the same file or one reachable via a relative import. Implemented
 * names that resolve only to interfaces (not captured as nodes yet) are skipped,
 * consistent with how the core skips unresolved superclasses.
 */
export const implementsEnricher: GraphEnricher = {
  name: 'implements',
  layer: 'A',
  enrich(builder, fingerprints) {
    const knownPaths = new Set(Object.keys(fingerprints));
    for (const fp of Object.values(fingerprints)) {
      const symbolFile = importedSymbolFiles(fp, knownPaths);
      for (const cls of fp.classes) {
        if (!cls.implements?.length) continue;
        const childId = `class:${fp.filePath}:${cls.name}`;
        for (const iface of cls.implements) {
          if (fp.classes.some(c => c.name === iface && c.name !== cls.name)) {
            builder.addEdge(childId, `class:${fp.filePath}:${iface}`, 'implements', 0.9);
            continue;
          }
          const srcFile = symbolFile.get(iface);
          if (srcFile && fingerprints[srcFile]?.classes.some(c => c.name === iface)) {
            builder.addEdge(childId, `class:${srcFile}:${iface}`, 'implements', 0.9);
          }
        }
      }
    }
  },
};

/**
 * `tested_by` — source file → test file that imports it. Only test files (by
 * naming/location) become edge targets; the resolved import determines the
 * source.
 */
export const testedByEnricher: GraphEnricher = {
  name: 'tested_by',
  layer: 'A',
  enrich(builder, fingerprints) {
    const knownPaths = new Set(Object.keys(fingerprints));
    for (const fp of Object.values(fingerprints)) {
      if (!isTestFile(fp.filePath)) continue;
      for (const imp of fp.imports) {
        const resolved = resolveImportPath(fp.filePath, imp.source, knownPaths);
        if (!resolved || isTestFile(resolved)) continue;
        builder.addEdge(`file:${resolved}`, `file:${fp.filePath}`, 'tested_by', 0.6);
      }
    }
  },
};

/**
 * `depends_on` — file-level dependency rollup. Aggregates each file's imports to
 * a coarse file→file edge (resolved relative imports) or file→module edge
 * (external packages), independent of the symbol-level `imports` edges.
 */
export const dependsOnEnricher: GraphEnricher = {
  name: 'depends_on',
  layer: 'A',
  enrich(builder, fingerprints) {
    const knownPaths = new Set(Object.keys(fingerprints));
    for (const fp of Object.values(fingerprints)) {
      const fileId = `file:${fp.filePath}`;
      for (const imp of fp.imports) {
        const resolved = resolveImportPath(fp.filePath, imp.source, knownPaths);
        if (resolved) {
          if (resolved !== fp.filePath) {
            builder.addEdge(fileId, `file:${resolved}`, 'depends_on', 0.5);
          }
        } else {
          builder.addEdge(fileId, `module:${imp.source}`, 'depends_on', 0.5);
        }
      }
    }
  },
};

/**
 * Classify a non-source asset file path into a node type, or null if it isn't
 * one of the recognized kinds. Order matters — most-specific checks first.
 */
export function classifyAssetFile(filePath: string): {
  type: 'config' | 'document' | 'pipeline' | 'service' | 'schema';
} | null {
  const name = filePath.split('/').pop() ?? filePath;
  const lower = name.toLowerCase();

  // pipeline — CI/CD workflow definitions
  if (/(^|\/)\.github\/workflows\//.test(filePath) || /(^|\/)\.gitlab-ci\.ya?ml$/.test(filePath)) {
    return { type: 'pipeline' };
  }
  // service — container/orchestration definitions
  if (lower === 'dockerfile' || /^docker-compose.*\.ya?ml$/.test(lower)) {
    return { type: 'service' };
  }
  // schema — database schema / migrations
  if (lower.endsWith('.sql') || lower.endsWith('.prisma') || lower === 'schema.graphql') {
    return { type: 'schema' };
  }
  // document — human-readable docs
  if (lower.endsWith('.md') || lower.endsWith('.mdx') || lower.endsWith('.rst')) {
    return { type: 'document' };
  }
  // config — known configuration files (catch-all, least specific)
  if (
    lower === 'package.json' ||
    /^tsconfig.*\.json$/.test(lower) ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.yml') ||
    lower.endsWith('.toml') ||
    /^\.[\w.-]*(rc|config)(\.\w+)?$/.test(lower) ||
    /\.config\.[cm]?[jt]s$/.test(lower)
  ) {
    return { type: 'config' };
  }
  return null;
}

/**
 * File classifier — turns non-source asset files (from `ctx.assetFiles`) into
 * `config`/`document`/`pipeline`/`service`/`schema` nodes.
 */
export const fileClassifierEnricher: GraphEnricher = {
  name: 'file_classifier',
  layer: 'A',
  enrich(builder, _fingerprints, ctx) {
    for (const filePath of ctx.assetFiles ?? []) {
      const classified = classifyAssetFile(filePath);
      if (!classified) continue;
      builder.addNode({
        id: `${classified.type}:${filePath}`,
        type: classified.type,
        name: filePath.split('/').pop() ?? filePath,
        filePath,
      });
    }
  },
};

/** All A-layer enrichers, in run order. */
export const A_LAYER_ENRICHERS: GraphEnricher[] = [
  implementsEnricher,
  testedByEnricher,
  dependsOnEnricher,
  fileClassifierEnricher,
];

// ---------------------------------------------------------------------------
// B-layer enrichers — framework-aware static pattern extraction (zero token).
//
// These read raw source from `ctx.sources` because the structural fingerprint
// only records callee *names*, not the string arguments (route paths, event
// names) these patterns need. Patterns are deliberately conservative to keep
// false positives low; they are heuristic, not a full parse.
// ---------------------------------------------------------------------------

const HTTP_METHODS = 'get|post|put|delete|patch|options|head|all';

/** Resolve a symbol name to a function node id (local first, then via imports). */
function resolveFunctionNode(
  name: string,
  fp: FileFingerprint,
  fingerprints: Record<string, FileFingerprint>,
  knownPaths: Set<string>
): string | null {
  if (fp.functions.some(f => f.name === name)) {
    return `function:${fp.filePath}:${name}`;
  }
  const srcFile = importedSymbolFiles(fp, knownPaths).get(name);
  if (srcFile && fingerprints[srcFile]?.functions.some(f => f.name === name)) {
    return `function:${srcFile}:${name}`;
  }
  return null;
}

/** Iterate source files (those with a fingerprint) and their raw content. */
function* sourceContents(
  fingerprints: Record<string, FileFingerprint>,
  ctx: EnrichContext
): Generator<{ filePath: string; content: string; fp: FileFingerprint }> {
  const sources = ctx.sources ?? {};
  for (const [filePath, fp] of Object.entries(fingerprints)) {
    const content = sources[filePath];
    if (content) yield { filePath, content, fp };
  }
}

/**
 * `endpoint` nodes + `routes` edges — HTTP route registrations, both
 * call-style (`app.get('/path', …)`) and decorator-style (`@Get('/path')`).
 * The route path must start with `/` to avoid matching `map.get('key')`.
 */
export const routesEnricher: GraphEnricher = {
  name: 'routes',
  layer: 'B',
  enrich(builder, fingerprints, ctx) {
    const callRe = new RegExp(`\\.(${HTTP_METHODS})\\s*\\(\\s*(['"\`])(/[^'"\`]*)\\2`, 'gi');
    const decoratorRe = new RegExp(`@(${HTTP_METHODS})\\s*\\(\\s*(['"\`])(/[^'"\`]*)\\2`, 'gi');
    for (const { filePath, content } of sourceContents(fingerprints, ctx)) {
      const add = (method: string, path: string) => {
        const label = `${method.toUpperCase()} ${path}`;
        const id = `endpoint:${filePath}:${label}`;
        builder.addNode({ id, type: 'endpoint', name: label, filePath });
        builder.addEdge(`file:${filePath}`, id, 'routes', 0.8);
      };
      for (const m of content.matchAll(callRe)) add(m[1], m[3]);
      for (const m of content.matchAll(decoratorRe)) add(m[1], m[3]);
    }
  },
};

/**
 * `subscribes` / `publishes` edges — event listeners and emitters with a
 * string event name, linked to a shared `concept:event:<name>` node.
 */
export const eventsEnricher: GraphEnricher = {
  name: 'events',
  layer: 'B',
  enrich(builder, fingerprints, ctx) {
    const subRe = /\.(on|once|addEventListener|subscribe)\s*\(\s*(['"`])([^'"`]+)\2/g;
    const pubRe = /\.(emit|publish|dispatch|next)\s*\(\s*(['"`])([^'"`]+)\2/g;
    for (const { filePath, content } of sourceContents(fingerprints, ctx)) {
      const link = (event: string, edge: 'subscribes' | 'publishes') => {
        const id = `concept:event:${event}`;
        builder.addNode({ id, type: 'concept', name: event });
        builder.addEdge(`file:${filePath}`, id, edge, 0.6);
      };
      for (const m of content.matchAll(subRe)) link(m[3], 'subscribes');
      for (const m of content.matchAll(pubRe)) link(m[3], 'publishes');
    }
  },
};

/**
 * `middleware` edges — `app.use(handler)` on a server-like receiver, where the
 * argument is a bare identifier resolvable to a function node. Inline calls and
 * non-server receivers are skipped.
 */
export const middlewareEnricher: GraphEnricher = {
  name: 'middleware',
  layer: 'B',
  enrich(builder, fingerprints, ctx) {
    const knownPaths = new Set(Object.keys(fingerprints));
    const useRe = /\b(?:app|router|server|api)\.use\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
    for (const { filePath, content, fp } of sourceContents(fingerprints, ctx)) {
      for (const m of content.matchAll(useRe)) {
        const target = resolveFunctionNode(m[1], fp, fingerprints, knownPaths);
        if (target) builder.addEdge(`file:${filePath}`, target, 'middleware', 0.6);
      }
    }
  },
};

/**
 * `reads_from` / `writes_to` edges — conservative filesystem and database
 * access patterns linked to coarse `resource:filesystem` / `resource:database`
 * nodes.
 */
export const dataAccessEnricher: GraphEnricher = {
  name: 'data_access',
  layer: 'B',
  enrich(builder, fingerprints, ctx) {
    const fsRead = /\bfs(?:\.promises)?\.(readFile|readFileSync|read|createReadStream)\b/;
    const fsWrite = /\bfs(?:\.promises)?\.(writeFile|writeFileSync|write|appendFile|createWriteStream|unlink|rm|mkdir)\b/;
    const dbQuery = /\b\w+\.query\s*\(/;
    for (const { filePath, content } of sourceContents(fingerprints, ctx)) {
      const fileId = `file:${filePath}`;
      const link = (resource: string, edge: 'reads_from' | 'writes_to') => {
        const id = `resource:${resource}`;
        builder.addNode({ id, type: 'resource', name: resource });
        builder.addEdge(fileId, id, edge, 0.5);
      };
      if (fsRead.test(content)) link('filesystem', 'reads_from');
      if (fsWrite.test(content)) link('filesystem', 'writes_to');
      if (dbQuery.test(content)) link('database', 'reads_from');
    }
  },
};

/**
 * `table` nodes + `defines_schema` edges — Prisma `model` blocks and SQL
 * `CREATE TABLE` statements, sourced from `.prisma` / `.sql` content. The
 * `schema:<path>` node is created by the A-layer classifier.
 */
export const schemaTablesEnricher: GraphEnricher = {
  name: 'schema_tables',
  layer: 'B',
  enrich(builder, _fingerprints, ctx) {
    const prismaRe = /\bmodel\s+(\w+)\s*\{/g;
    const sqlRe = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?[`"'\[]?(\w+)/gi;
    for (const [filePath, content] of Object.entries(ctx.sources ?? {})) {
      const lower = filePath.toLowerCase();
      let re: RegExp | null = null;
      if (lower.endsWith('.prisma')) re = prismaRe;
      else if (lower.endsWith('.sql')) re = sqlRe;
      if (!re) continue;

      for (const m of content.matchAll(re)) {
        const name = m[1];
        const tableId = `table:${filePath}:${name}`;
        builder.addNode({ id: tableId, type: 'table', name, filePath });
        builder.addEdge(`schema:${filePath}`, tableId, 'defines_schema', 0.8);
      }
    }
  },
};

/** All B-layer enrichers, in run order. */
export const B_LAYER_ENRICHERS: GraphEnricher[] = [
  routesEnricher,
  eventsEnricher,
  middlewareEnricher,
  dataAccessEnricher,
  schemaTablesEnricher,
];

// ---------------------------------------------------------------------------
// C-layer enrichers — embedding similarity (zero token, needs an
// EmbeddingService). Self-skip when `ctx.embeddings` is absent, mirroring how
// B enrichers self-skip without `ctx.sources`.
//
// ⚠️ With the TemplateEmbeddingService stub these edges reflect lexical overlap,
// not semantics — green tests prove the wiring, not the relationships. C-layer
// "done" requires a real-model eval (docs/GRAPH-ENRICHMENT-PLAN.md §7.8).
// ---------------------------------------------------------------------------

/** Cosine ≥ this → `similar_to` (near-duplicate / reuse candidate). */
const SIMILAR_THRESHOLD = 0.85;
/** Cosine in [RELATED_THRESHOLD, SIMILAR_THRESHOLD) → `related` (topical). */
const RELATED_THRESHOLD = 0.7;
/** Keep at most this many similarity edges per node, to bound graph density. */
const TOP_K = 5;
/**
 * Skip same-type similarity for a group larger than this. Pairwise cosine is
 * O(n²); above this we log and skip the group rather than silently truncate or
 * stall (project no-silent-caps rule). Bucketed top-K degrade is a later refinement.
 */
const MAX_GROUP_SIZE = 2000;

/** An embeddable node: a graph node id paired with the text we embed for it. */
interface EmbeddableNode {
  id: string;
  text: string;
}

/**
 * Build the deterministic text we embed for each function/class/file node, from
 * the structural fingerprint (+ raw source for the file's leading comment). The
 * node `summary` is still empty at build time (a D-layer product), so we use the
 * signature surface that is available now. See PLAN §7.2.
 */
function collectEmbeddableNodes(
  fingerprints: Record<string, FileFingerprint>,
  ctx: EnrichContext
): { functions: EmbeddableNode[]; classes: EmbeddableNode[]; files: EmbeddableNode[] } {
  const functions: EmbeddableNode[] = [];
  const classes: EmbeddableNode[] = [];
  const files: EmbeddableNode[] = [];
  const sources = ctx.sources ?? {};

  for (const fp of Object.values(fingerprints)) {
    for (const fn of fp.functions) {
      const params = fn.params.join(', ');
      const ret = fn.returnType ? ` -> ${fn.returnType}` : '';
      const calls = fn.calls?.length ? ` calls ${fn.calls.join(' ')}` : '';
      functions.push({
        id: `function:${fp.filePath}:${fn.name}`,
        text: `${fn.name}(${params})${ret}${calls}`,
      });
    }
    for (const cls of fp.classes) {
      const parts = [cls.name];
      if (cls.superClass) parts.push(`extends ${cls.superClass}`);
      if (cls.implements?.length) parts.push(`implements ${cls.implements.join(' ')}`);
      if (cls.methods.length) parts.push(`methods ${cls.methods.join(' ')}`);
      if (cls.properties.length) parts.push(`props ${cls.properties.join(' ')}`);
      classes.push({
        id: `class:${fp.filePath}:${cls.name}`,
        text: parts.join(' '),
      });
    }
    const basename = fp.filePath.split('/').pop() ?? fp.filePath;
    const exportNames = fp.exports.map((e) => e.name).join(' ');
    const comment = leadingComment(sources[fp.filePath]);
    files.push({
      id: `file:${fp.filePath}`,
      text: `${basename} ${exportNames} ${comment}`.trim(),
    });
  }

  return { functions, classes, files };
}

/** Extract a short leading-comment / first-meaningful-line snippet from source. */
function leadingComment(content: string | undefined): string {
  if (!content) return '';
  const lines = content.split('\n').slice(0, 20);
  const picked: string[] = [];
  for (const raw of lines) {
    const line = raw.trim().replace(/^(\/\/+|\/\*+|\*+\/?|#)\s?/, '').trim();
    if (line) picked.push(line);
    if (picked.length >= 3) break;
  }
  return picked.join(' ').slice(0, 200);
}

/**
 * Within one same-type group, add similarity edges. For each node keeps its
 * top-K neighbours with cosine ≥ RELATED_THRESHOLD; each surviving pair becomes a
 * single canonical edge (min id → max id) banded into `similar_to` / `related`.
 * Canonicalizing the direction dedupes the i→j / j→i pair (both bands agree
 * since cosine is symmetric) and keeps the propagation graph clean.
 */
function addSimilarityEdges(
  builder: KnowledgeGraphBuilder,
  group: EmbeddableNode[],
  vectors: number[][]
): void {
  if (group.length > MAX_GROUP_SIZE) {
    logger.warn(
      `Skipping similarity for ${group.length} nodes (> ${MAX_GROUP_SIZE}); ` +
        `pairwise cosine is O(n²). Bucketed degrade not yet implemented.`
    );
    return;
  }

  const n = group.length;
  // Precompute the full upper-triangle similarities once.
  const sims: Array<{ i: number; j: number; cos: number }> = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const cos = cosineSimilarity(vectors[i], vectors[j]);
      if (cos >= RELATED_THRESHOLD) sims.push({ i, j, cos });
    }
  }

  // Per-node top-K selection (a pair survives if it is in EITHER endpoint's top-K).
  const perNode = new Map<number, Array<{ other: number; cos: number }>>();
  for (const { i, j, cos } of sims) {
    (perNode.get(i) ?? perNode.set(i, []).get(i)!).push({ other: j, cos });
    (perNode.get(j) ?? perNode.set(j, []).get(j)!).push({ other: i, cos });
  }
  const kept = new Set<string>();
  for (const [node, neighbors] of perNode) {
    neighbors.sort((a, b) => b.cos - a.cos);
    for (const { other } of neighbors.slice(0, TOP_K)) {
      const a = Math.min(node, other);
      const b = Math.max(node, other);
      kept.add(`${a}-${b}`);
    }
  }

  for (const { i, j, cos } of sims) {
    if (!kept.has(`${i}-${j}`)) continue;
    const a = group[Math.min(i, j)].id;
    const b = group[Math.max(i, j)].id;
    const type = cos >= SIMILAR_THRESHOLD ? 'similar_to' : 'related';
    builder.addEdge(a, b, type, cos);
  }
}

/**
 * `similar_to` / `related` edges — embed function/class/file nodes and connect
 * the most-similar same-type pairs (threshold-banded, top-K capped). Compares
 * only within a type to keep the candidate set small.
 */
export const embeddingsEnricher: GraphEnricher = {
  name: 'embeddings',
  layer: 'C',
  async enrich(builder, fingerprints, ctx) {
    const embeddings = ctx.embeddings;
    if (!embeddings) return; // self-skip without a provider

    const { functions, classes, files } = collectEmbeddableNodes(fingerprints, ctx);
    for (const group of [functions, classes, files]) {
      if (group.length < 2) continue;
      if (group.length > MAX_GROUP_SIZE) {
        // Surfaced here too: skip before paying for embeddings we won't use.
        addSimilarityEdges(builder, group, []);
        continue;
      }
      const vectors = await embeddings.embed(group.map((g) => g.text));
      addSimilarityEdges(builder, group, vectors);
    }
  },
};

// ---------------------------------------------------------------------------
// C-layer: concept clustering. Concepts are cross-cutting, so unlike the
// similarity edges (within a node type) this pools function/class/file nodes
// together and groups them by embedding proximity. C produces ANONYMOUS clusters
// — the human-meaningful name ("session-refresh") is a D-layer product; here the
// name is a placeholder common token, refined later by `rename` in D.
// ---------------------------------------------------------------------------

/** Cosine ≥ this connects two nodes into the same concept cluster. */
const CLUSTER_THRESHOLD = 0.8;
/** Clusters smaller than this are dropped (a lone node is not a concept). */
const MIN_CLUSTER_SIZE = 2;
/** Stop-words excluded when picking a cluster's placeholder name. */
const NAME_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'class',
  'function', 'const', 'return', 'export', 'import', 'extends', 'implements',
  'methods', 'props', 'calls', 'void', 'string', 'number', 'boolean',
]);

/** Union-find root with path compression. */
function find(parent: number[], x: number): number {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]];
    x = parent[x];
  }
  return x;
}

/**
 * Pick a placeholder name for a cluster: the alphanumeric token shared by the
 * most members (document frequency), tie-broken by length then alphabetically
 * for determinism. Returns null if no token is shared by ≥2 members.
 */
function commonToken(texts: string[]): string | null {
  const df = new Map<string, number>();
  for (const text of texts) {
    const seen = new Set<string>();
    for (const tok of text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []) {
      if (NAME_STOPWORDS.has(tok) || seen.has(tok)) continue;
      seen.add(tok);
      df.set(tok, (df.get(tok) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestDf = 1; // require shared by ≥2
  for (const [tok, count] of df) {
    if (
      count > bestDf ||
      (count === bestDf &&
        best !== null &&
        (tok.length > best.length || (tok.length === best.length && tok < best)))
    ) {
      best = tok;
      bestDf = count;
    }
  }
  return best;
}

/**
 * `concept:cluster:<hash>` nodes + member `related` edges. Pools all embeddable
 * nodes, connects pairs with cosine ≥ CLUSTER_THRESHOLD via union-find, and emits
 * one concept node per connected component of size ≥ MIN_CLUSTER_SIZE. The node
 * id is a stable hash of the sorted member ids (deterministic across runs); the
 * name is a placeholder common token (D layer renames it).
 */
export const clusterEnricher: GraphEnricher = {
  name: 'concept_clusters',
  layer: 'C',
  async enrich(builder, fingerprints, ctx) {
    const embeddings = ctx.embeddings;
    if (!embeddings) return; // self-skip without a provider

    const { functions, classes, files } = collectEmbeddableNodes(fingerprints, ctx);
    const pooled = [...functions, ...classes, ...files];
    if (pooled.length < MIN_CLUSTER_SIZE) return;
    if (pooled.length > MAX_GROUP_SIZE) {
      logger.warn(
        `Skipping concept clustering for ${pooled.length} nodes (> ${MAX_GROUP_SIZE}); ` +
          `pairwise cosine is O(n²). Bucketed degrade not yet implemented.`
      );
      return;
    }

    // NOTE: re-embeds the same nodes as embeddingsEnricher; task #4 caches
    // vectors by fingerprint hash, making the second pass free.
    const vectors = await embeddings.embed(pooled.map((p) => p.text));

    // Connected components at CLUSTER_THRESHOLD.
    const parent = pooled.map((_, i) => i);
    for (let i = 0; i < pooled.length; i++) {
      for (let j = i + 1; j < pooled.length; j++) {
        if (cosineSimilarity(vectors[i], vectors[j]) >= CLUSTER_THRESHOLD) {
          parent[find(parent, i)] = find(parent, j);
        }
      }
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < pooled.length; i++) {
      const root = find(parent, i);
      (groups.get(root) ?? groups.set(root, []).get(root)!).push(i);
    }

    for (const members of groups.values()) {
      if (members.length < MIN_CLUSTER_SIZE) continue;
      const memberIds = members.map((i) => pooled[i].id).sort();
      const hash = createHash(memberIds.join('|')).slice(0, 8);
      const clusterId = `concept:cluster:${hash}`;
      const name = commonToken(members.map((i) => pooled[i].text)) ?? `cluster-${hash.slice(0, 6)}`;
      builder.addNode({ id: clusterId, type: 'concept', name });
      for (const id of memberIds) {
        builder.addEdge(id, clusterId, 'related', 0.5);
      }
    }
  },
};

/** All C-layer enrichers, in run order. */
export const C_LAYER_ENRICHERS: GraphEnricher[] = [embeddingsEnricher, clusterEnricher];

// ---------------------------------------------------------------------------
// D-layer enrichers — LLM semantics (requires LlmService, optional cache).
// These are gated by `enabledLayers` and self-skip when `ctx.llm` is absent.
// ---------------------------------------------------------------------------

function functionSignature(fn: FileFingerprint['functions'][number]): string {
  const params = fn.params.join(', ');
  const ret = fn.returnType ? `: ${fn.returnType}` : '';
  return `${fn.name}(${params})${ret}`;
}

function classSignature(cls: FileFingerprint['classes'][number]): string {
  const parts = [`class ${cls.name}`];
  if (cls.superClass) parts.push(`extends ${cls.superClass}`);
  if (cls.implements?.length) parts.push(`implements ${cls.implements.join(', ')}`);
  return parts.join(' ');
}

function extractBody(content: string | undefined, startLine: number, endLine: number): string {
  if (!content) return '';
  const lines = content.split('\n');
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);
  return lines.slice(start, end).join('\n').slice(0, 1200);
}

function extractFileSnippet(content: string | undefined, maxLines = 50): string {
  if (!content) return '';
  return content.split('\n').slice(0, maxLines).join('\n').slice(0, 2000);
}

/**
 * `summary` + `tags` — summarize function/class/file nodes using LLM.
 */
export const summaryEnricher: GraphEnricher = {
  name: 'summary',
  layer: 'D',
  async enrich(builder, fingerprints, ctx) {
    if (!ctx.llm) return;
    const sources = ctx.sources ?? {};
    for (const fp of Object.values(fingerprints)) {
      const source = sources[fp.filePath];

      // File node
      const fileNodeId = `file:${fp.filePath}`;
      if (builder.findNode(fileNodeId)) {
        const key = `summary:${fileNodeId}:${fp.contentHash}`;
        const cached = ctx.llmCache?.get<NodeSummaryResult>(key);
        const result = cached ?? await ctx.llm.summarizeNode({
          nodeType: 'file',
          name: fp.filePath.split('/').pop() ?? fp.filePath,
          signature: fp.filePath,
          codeSnippet: extractFileSnippet(source),
        });
        builder.updateNode(fileNodeId, { summary: result.summary, tags: result.tags });
        ctx.llmCache?.set(key, result);
      }

      // Function nodes
      for (const fn of fp.functions) {
        const nodeId = `function:${fp.filePath}:${fn.name}`;
        if (!builder.findNode(nodeId)) continue;
        const key = `summary:${nodeId}:${fp.contentHash}`;
        const cached = ctx.llmCache?.get<NodeSummaryResult>(key);
        const result = cached ?? await ctx.llm.summarizeNode({
          nodeType: 'function',
          name: fn.name,
          signature: functionSignature(fn),
          codeSnippet: extractBody(source, fn.startLine, fn.endLine),
        });
        builder.updateNode(nodeId, { summary: result.summary, tags: result.tags });
        ctx.llmCache?.set(key, result);
      }

      // Class nodes
      for (const cls of fp.classes) {
        const nodeId = `class:${fp.filePath}:${cls.name}`;
        if (!builder.findNode(nodeId)) continue;
        const key = `summary:${nodeId}:${fp.contentHash}`;
        const cached = ctx.llmCache?.get<NodeSummaryResult>(key);
        const result = cached ?? await ctx.llm.summarizeNode({
          nodeType: 'class',
          name: cls.name,
          signature: classSignature(cls),
          codeSnippet: extractBody(source, cls.startLine, cls.endLine),
        });
        builder.updateNode(nodeId, { summary: result.summary, tags: result.tags });
        ctx.llmCache?.set(key, result);
      }
    }
  },
};

/**
 * `concept` cluster naming — rename anonymous C-layer clusters using LLM.
 */
export const conceptNamingEnricher: GraphEnricher = {
  name: 'concept_naming',
  layer: 'D',
  async enrich(builder, _fingerprints, ctx) {
    if (!ctx.llm) return;
    const clusters = builder.getNodesByType('concept').filter(n => n.id.startsWith('concept:cluster:'));
    for (const cluster of clusters) {
      const members = builder.findNeighbors(cluster.id, 'related');
      if (members.length === 0) continue;
      const key = `concept-name:${cluster.id}`;
      const cached = ctx.llmCache?.get<ConceptNameResult>(key);
      const result = cached ?? await ctx.llm.nameConceptCluster({
        members: members.map(m => ({ id: m.id, name: m.name, summary: m.summary })),
      });
      builder.updateNode(cluster.id, { name: result.name });
      ctx.llmCache?.set(key, result);
    }
  },
};

/**
 * Architecture layer classification — create `concept:layer:*` nodes and link files.
 */
export const architectureLayerEnricher: GraphEnricher = {
  name: 'architecture_layer',
  layer: 'D',
  async enrich(builder, fingerprints, ctx) {
    if (!ctx.llm) return;
    for (const fp of Object.values(fingerprints)) {
      const fileNodeId = `file:${fp.filePath}`;
      const fileNode = builder.findNode(fileNodeId);
      if (!fileNode) continue;

      const key = `layer:${fileNodeId}:${fp.contentHash}`;
      const cached = ctx.llmCache?.get<ArchitectureLayerResult>(key);
      const result = cached ?? await ctx.llm.classifyArchitectureLayer({
        nodeType: 'file',
        name: fileNode.name,
        signature: fp.filePath,
        neighbors: builder.findNeighbors(fileNodeId).map(n => n.name),
      });

      if (result.layer !== 'unknown') {
        const layerId = `concept:layer:${result.layer}`;
        builder.addNode({ id: layerId, type: 'concept', name: result.layer });
        builder.addEdge(fileNodeId, layerId, 'related', result.confidence);
        const existingTags = fileNode.tags ?? [];
        const layerTag = `layer:${result.layer}`;
        if (!existingTags.includes(layerTag)) {
          builder.updateNode(fileNodeId, { tags: [...existingTags, layerTag] });
        }
      }
      ctx.llmCache?.set(key, result);
    }
  },
};

/**
 * Semantic edges — identify `transforms` / `validates` relationships between functions.
 *
 * Strategy:
 * 1. Build candidate pairs from existing `calls` edges (bidirectional), because a
 *    callee often validates/transforms data for its caller, and a caller may
 *    transform data before passing it to a callee.
 * 2. Fall back to all ordered pairs for small files without call data.
 * 3. Batch candidate pairs (not functions) so each LLM request stays small and
 *    no single pair is ever split across batches.
 */
export const semanticEdgeEnricher: GraphEnricher = {
  name: 'semantic_edges',
  layer: 'D',
  async enrich(builder, fingerprints, ctx) {
    if (!ctx.llm || !ctx.sources) return;

    for (const fp of Object.values(fingerprints)) {
      const source = ctx.sources[fp.filePath];
      if (!source) continue;
      if (fp.functions.length === 0) continue;

      const funcIds = new Set(
        fp.functions.map(f => `function:${fp.filePath}:${f.name}`)
      );

      // 1. Build bidirectional candidate pairs from `calls` edges.
      const candidatePairs: Array<{ source: string; target: string }> = [];
      const seen = new Set<string>();

      const addCandidate = (src: string, tgt: string) => {
        if (src === tgt) return;
        const key = `${src}|${tgt}`;
        if (seen.has(key)) return;
        seen.add(key);
        candidatePairs.push({ source: src, target: tgt });
      };

      for (const fn of fp.functions) {
        const callerId = `function:${fp.filePath}:${fn.name}`;
        const outgoing = builder.getEdgesBySource(callerId);
        for (const edge of outgoing) {
          if (edge.type !== 'calls') continue;
          if (!funcIds.has(edge.target)) continue;

          // callee -> caller: typical validate/transform provider
          addCandidate(edge.target, edge.source);
          // caller -> callee: caller may prepare/transform data before call
          addCandidate(edge.source, edge.target);
        }
      }

      // 2. Fallback for small files without call data: all ordered pairs.
      if (candidatePairs.length === 0 && fp.functions.length <= 8) {
        for (let i = 0; i < fp.functions.length; i++) {
          for (let j = 0; j < fp.functions.length; j++) {
            if (i === j) continue;
            const src = `function:${fp.filePath}:${fp.functions[i].name}`;
            const tgt = `function:${fp.filePath}:${fp.functions[j].name}`;
            addCandidate(src, tgt);
          }
        }
      }

      if (candidatePairs.length === 0) continue;

      // 3. Batch pairs atomically by referenced function count and pair count.
      const batches: Array<typeof candidatePairs> = [];
      let current: typeof candidatePairs = [];
      const currentFuncs = new Set<string>();

      for (const pair of candidatePairs) {
        const nextFuncs = new Set(currentFuncs);
        nextFuncs.add(pair.source);
        nextFuncs.add(pair.target);

        if (
          current.length >= MAX_SEMANTIC_PAIRS_PER_BATCH ||
          nextFuncs.size > MAX_SEMANTIC_FUNCS_PER_BATCH
        ) {
          batches.push(current);
          current = [pair];
          currentFuncs.clear();
          currentFuncs.add(pair.source);
          currentFuncs.add(pair.target);
        } else {
          current.push(pair);
          currentFuncs.add(pair.source);
          currentFuncs.add(pair.target);
        }
      }
      if (current.length) batches.push(current);

      // 4. Run one LLM request per batch.
      // Cache key is versioned (v2) so old cached empty results are not reused.
      const baseKey = `semantic-edges:v2:${fp.filePath}:${fp.contentHash}`;

      for (let idx = 0; idx < batches.length; idx++) {
        const batch = batches[idx];
        const referencedIds = new Set(batch.flatMap(p => [p.source, p.target]));

        const functions = fp.functions
          .filter(f => referencedIds.has(`function:${fp.filePath}:${f.name}`))
          .map(fn => ({
            id: `function:${fp.filePath}:${fn.name}`,
            name: fn.name,
            signature: functionSignature(fn),
            body: extractBody(source, fn.startLine, fn.endLine),
          }));

        const cacheKey = `${baseKey}:batch:${idx}`;
        const cached = ctx.llmCache?.get<SemanticEdgesResult>(cacheKey);
        const result = cached ?? await ctx.llm.detectSemanticEdges({ functions, candidates: batch });

        for (const edge of result.edges) {
          if (edge.source === edge.target) continue;
          if (!builder.findNode(edge.source) || !builder.findNode(edge.target)) continue;
          if (edge.type !== 'transforms' && edge.type !== 'validates') continue;
          builder.addEdge(edge.source, edge.target, edge.type, edge.confidence);
        }

        ctx.llmCache?.set(cacheKey, result);
      }
    }
  },
};

/** All D-layer enrichers, in run order. */
export const D_LAYER_ENRICHERS: GraphEnricher[] = [
  summaryEnricher,
  conceptNamingEnricher,
  architectureLayerEnricher,
  semanticEdgeEnricher,
];