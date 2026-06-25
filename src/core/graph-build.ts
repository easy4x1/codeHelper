import { KnowledgeGraphBuilder } from './knowledge-graph.js';
import type { FileFingerprint, KnowledgeGraph } from './types.js';

/**
 * Knowledge-graph construction from file fingerprints.
 *
 * Builds, in addition to the basic `contains`/`imports`/`exports` edges:
 *  - `calls`    — function → function, resolved within a file and across files
 *                 via relative imports (enables cross-file call-chain propagation).
 *  - `inherits` — class → superclass, resolved within a file or via imports.
 *  - symbol-level `imports` — a file imports a *specific* exported function/class
 *                 node rather than only a coarse `module:` node, so propagation
 *                 reaches the precise symbol. Coarse `module:` nodes are kept for
 *                 external (non-relative) packages.
 *
 * This is the single source of truth shared by `init` (whole-repo build) and
 * `sync` (per-file rebuild), so the two paths never drift.
 */

const FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java'];

function basename(p: string): string {
  return p.split('/').pop() || p;
}

function dirnamePosix(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function normalizePosix(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

/**
 * Resolve a relative import specifier to a known file path. Returns null for
 * external packages (non-relative) or specifiers that match no known file.
 *
 * Handles ESM-in-TypeScript quirks where the specifier ends in `.js` but the
 * source file is `.ts`, plus extensionless and `index.*` directory imports.
 */
export function resolveImportPath(
  importerPath: string,
  source: string,
  knownPaths: Set<string>
): string | null {
  if (!source.startsWith('.')) return null;

  const target = normalizePosix(`${dirnamePosix(importerPath)}/${source}`);
  const stripped = target.replace(/\.(js|jsx|mjs|cjs|ts|tsx)$/, '');

  const candidates: string[] = [];
  for (const base of new Set([target, stripped])) {
    candidates.push(base);
    for (const ext of FILE_EXTENSIONS) {
      candidates.push(base + ext);
      candidates.push(`${base}/index${ext}`);
    }
  }
  for (const c of candidates) {
    if (knownPaths.has(c)) return c;
  }
  return null;
}

/**
 * Add all nodes and edges for a single file to the builder. `fingerprints`
 * provides the full repo view needed to resolve cross-file references.
 */
export function addFileToGraph(
  builder: KnowledgeGraphBuilder,
  filePath: string,
  fp: FileFingerprint,
  fingerprints: Record<string, FileFingerprint>,
  knownPaths: Set<string>
): void {
  builder.addNode({ id: `file:${filePath}`, type: 'file', name: basename(filePath), filePath });

  for (const fn of fp.functions) {
    const nodeId = `function:${filePath}:${fn.name}`;
    builder.addNode({
      id: nodeId,
      type: 'function',
      name: fn.name,
      filePath,
      metadata: { isExported: fn.isExported, returnType: fn.returnType },
    });
    builder.addEdge(`file:${filePath}`, nodeId, 'contains', 1.0);
  }

  for (const cls of fp.classes) {
    const nodeId = `class:${filePath}:${cls.name}`;
    builder.addNode({
      id: nodeId,
      type: 'class',
      name: cls.name,
      filePath,
      metadata: { isExported: cls.isExported, methods: cls.methods, properties: cls.properties },
    });
    builder.addEdge(`file:${filePath}`, nodeId, 'contains', 1.0);
  }

  // Imports — resolve relative specifiers to concrete symbol nodes; keep coarse
  // module nodes for external packages. Track where each imported name lives so
  // `calls`/`inherits` can resolve across files.
  const importedSymbolFile = new Map<string, string>();
  for (const imp of fp.imports) {
    const resolved = resolveImportPath(filePath, imp.source, knownPaths);

    if (!resolved) {
      const moduleId = `module:${imp.source}`;
      builder.addNode({ id: moduleId, type: 'module', name: imp.source });
      builder.addEdge(`file:${filePath}`, moduleId, 'imports', 0.7);
      continue;
    }

    const targetFp = fingerprints[resolved];
    if (imp.items.length === 0) {
      // Side-effect import: only a file-level dependency.
      builder.addEdge(`file:${filePath}`, `file:${resolved}`, 'imports', 0.7);
      continue;
    }

    for (const rawItem of imp.items) {
      const item = rawItem.replace(/^\*\s+as\s+/, '');
      importedSymbolFile.set(item, resolved);

      const fnHit = targetFp?.functions.some(f => f.name === item);
      const clsHit = targetFp?.classes.some(c => c.name === item);
      if (fnHit) {
        builder.addEdge(`file:${filePath}`, `function:${resolved}:${item}`, 'imports', 0.7);
      } else if (clsHit) {
        builder.addEdge(`file:${filePath}`, `class:${resolved}:${item}`, 'imports', 0.7);
      } else {
        // Imported name with no matching symbol node — fall back to file level.
        builder.addEdge(`file:${filePath}`, `file:${resolved}`, 'imports', 0.7);
      }
    }
  }

  // Calls — function → function, same file first, then via resolved imports.
  for (const fn of fp.functions) {
    if (!fn.calls?.length) continue;
    const callerId = `function:${filePath}:${fn.name}`;
    for (const calleeRaw of fn.calls) {
      const callee = calleeRaw.split('.').pop() || calleeRaw;
      if (callee === fn.name) continue;

      if (fp.functions.some(f => f.name === callee)) {
        builder.addEdge(callerId, `function:${filePath}:${callee}`, 'calls', 0.9);
        continue;
      }
      const srcFile = importedSymbolFile.get(callee);
      if (srcFile && fingerprints[srcFile]?.functions.some(f => f.name === callee)) {
        builder.addEdge(callerId, `function:${srcFile}:${callee}`, 'calls', 0.9);
      }
    }
  }

  // Inheritance — class → superclass, same file first, then via resolved imports.
  for (const cls of fp.classes) {
    if (!cls.superClass) continue;
    const childId = `class:${filePath}:${cls.name}`;

    if (fp.classes.some(c => c.name === cls.superClass && c.name !== cls.name)) {
      builder.addEdge(childId, `class:${filePath}:${cls.superClass}`, 'inherits', 0.9);
      continue;
    }
    const srcFile = importedSymbolFile.get(cls.superClass);
    if (srcFile && fingerprints[srcFile]?.classes.some(c => c.name === cls.superClass)) {
      builder.addEdge(childId, `class:${srcFile}:${cls.superClass}`, 'inherits', 0.9);
    }
  }

  // Exports — file exposes a symbol.
  for (const exp of fp.exports) {
    const targetId =
      exp.type === 'function'
        ? `function:${filePath}:${exp.name}`
        : exp.type === 'class'
          ? `class:${filePath}:${exp.name}`
          : `file:${filePath}`;
    builder.addEdge(`file:${filePath}`, targetId, 'exports', 0.8);
  }
}

/**
 * Build a complete knowledge graph from a map of file fingerprints.
 */
export function buildGraphFromFingerprints(
  fingerprints: Record<string, FileFingerprint>
): KnowledgeGraph {
  const builder = new KnowledgeGraphBuilder();
  const knownPaths = new Set(Object.keys(fingerprints));
  for (const [filePath, fp] of Object.entries(fingerprints)) {
    addFileToGraph(builder, filePath, fp, fingerprints, knownPaths);
  }
  return builder.build();
}
