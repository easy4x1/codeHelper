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
