import { KnowledgeGraphBuilder } from './knowledge-graph.js';
import { resolveImportPath } from './graph-build.js';
import type { FileFingerprint } from './types.js';

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
  llm?: unknown;
  /** C-layer dependency; absent → C enrichers self-skip. */
  embeddings?: unknown;
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
