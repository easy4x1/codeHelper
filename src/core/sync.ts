import { scanRepo } from './repo-scanner.js';
import { classifyChange } from './fingerprint.js';
import { KnowledgeGraphBuilder } from './knowledge-graph.js';
import { addFileToGraph } from './graph-build.js';
import { runEnrichers, A_LAYER_ENRICHERS, B_LAYER_ENRICHERS, C_LAYER_ENRICHERS, D_LAYER_ENRICHERS } from './graph-enrich.js';
import type {
  FileFingerprint,
  KnowledgeGraph,
  ChangeAnalysis,
  ChangeLevel,
} from './types.js';
import type { EmbeddingService } from './embedding-service.js';
import type { LlmService } from './llm-service.js';
import { LlmSemanticCache } from './llm-semantic-cache.js';
import { MemoryMiddleware } from './memory.js';
import { readFile } from 'fs/promises';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('sync');

export interface SyncOptions {
  repoPath: string;
  forceFull?: boolean;
  /**
   * Cache-backed embedding service for C-layer enrichment. When provided, the
   * sync re-runs similar_to/related + concept clustering alongside A/B; when
   * absent, only A/B run (C self-skips). Persisting the cache is the caller's job.
   */
  embeddings?: EmbeddingService;
  /**
   * Enable D-layer LLM semantic enrichment (summaries, concept naming,
   * architecture layers, semantic edges). Requires `llm`.
   */
  semantic?: boolean;
  /** D-layer dependency; required when `semantic` is true. */
  llm?: LlmService;
  /** D-layer result cache; optional but strongly recommended. */
  llmCache?: LlmSemanticCache;
}

export interface SyncResult {
  filesAnalyzed: number;
  filesUnchanged: number;
  filesCosmetic: number;
  filesStructural: number;
  filesAdded: number;
  filesDeleted: number;
  changes: ChangeAnalysis[];
  updatedGraph: KnowledgeGraph;
  updatedFingerprints: Record<string, FileFingerprint>;
}

/**
 * Incrementally sync a repository against existing memory.
 *
 * Strategy (per DESIGN.md §3.2.3):
 * - NONE     → skip (0 token)
 * - COSMETIC → skip analysis, update content hash only
 * - STRUCTURAL → re-analyze file, rebuild graph nodes
 * - New file → full analyze
 * - Deleted file → remove from graph and fingerprints
 */
export async function syncRepo(
  memory: MemoryMiddleware,
  options: SyncOptions
): Promise<SyncResult> {
  const repoPath = options.repoPath;
  const existingFingerprints = memory.getAllFingerprints();
  const existingGraph = memory.getKnowledgeGraph();

  logger.info(`Starting sync for ${repoPath}`);

  // 1. Scan current repo state
  const scanResult = await scanRepo(repoPath);
  const currentFingerprints = new Map<string, FileFingerprint>();
  for (const fp of scanResult.fingerprints) {
    currentFingerprints.set(fp.filePath, fp);
  }

  const existingPaths = new Set(Object.keys(existingFingerprints));
  const currentPaths = new Set(currentFingerprints.keys());

  const changes: ChangeAnalysis[] = [];
  const builder = KnowledgeGraphBuilder.fromGraph(existingGraph);
  const updatedFingerprints: Record<string, FileFingerprint> = {};

  // Full current-repo view, used to resolve cross-file calls/inherits/imports
  // when rebuilding any single file's nodes.
  const allFingerprints: Record<string, FileFingerprint> = Object.fromEntries(currentFingerprints);

  let filesUnchanged = 0;
  let filesCosmetic = 0;
  let filesStructural = 0;
  let filesAdded = 0;
  let filesDeleted = 0;

  // 2. Process each current file
  for (const [filePath, newFp] of currentFingerprints) {
    const oldFp = existingFingerprints[filePath] ?? null;

    if (options.forceFull) {
      // Force full re-analysis
      filesStructural++;
      updatedFingerprints[filePath] = newFp;
      rebuildGraphForFile(builder, filePath, newFp, allFingerprints);
      changes.push({
        filePath,
        changeLevel: 'STRUCTURAL',
        details: ['Forced full re-analysis'],
      });
      continue;
    }

    if (!oldFp) {
      // New file
      filesAdded++;
      updatedFingerprints[filePath] = newFp;
      rebuildGraphForFile(builder, filePath, newFp, allFingerprints);
      changes.push({
        filePath,
        changeLevel: 'STRUCTURAL',
        details: ['New file'],
      });
      continue;
    }

    const analysis = classifyChange(oldFp, newFp);
    changes.push(analysis);

    switch (analysis.changeLevel) {
      case 'NONE':
        filesUnchanged++;
        // Keep old fingerprint (hash matches, no need to update)
        updatedFingerprints[filePath] = oldFp;
        break;

      case 'COSMETIC':
        filesCosmetic++;
        // Content changed but structure identical — update hash only
        updatedFingerprints[filePath] = {
          ...oldFp,
          contentHash: newFp.contentHash,
          totalLines: newFp.totalLines,
        };
        break;

      case 'STRUCTURAL':
        filesStructural++;
        // Structure changed — rebuild graph nodes for this file
        updatedFingerprints[filePath] = newFp;
        rebuildGraphForFile(builder, filePath, newFp, allFingerprints);
        break;
    }
  }

  // 3. Process deleted files
  for (const filePath of existingPaths) {
    if (!currentPaths.has(filePath)) {
      filesDeleted++;
      changes.push({
        filePath,
        changeLevel: 'STRUCTURAL',
        details: ['File deleted'],
      });
      // Remove all nodes associated with this file
      removeFileFromGraph(builder, filePath);
    }
  }

  // 4. Re-run the enrichers graph-wide. They are zero-token static passes;
  // rebuilt files already had their enricher edges cleared with their nodes,
  // and addNode/addEdge dedupe, so this restores cross-file A-layer enrichment
  // (implements/tested_by/depends_on + asset classifier) and B-layer framework
  // patterns (routes/events/middleware/data-access/tables) without drift. C-layer
  // embedding enrichment (similar_to/related + concept clusters) runs only when an
  // embedding service is provided; its cache makes unchanged node texts free.
  const enabledLayers: Array<'A' | 'B' | 'C' | 'D'> = ['A', 'B'];
  if (options.embeddings) enabledLayers.push('C');
  if (options.semantic) enabledLayers.push('D');

  await runEnrichers(
    builder,
    allFingerprints,
    {
      enabledLayers,
      assetFiles: scanResult.assetFiles,
      sources: scanResult.sources,
      embeddings: options.embeddings,
      llm: options.semantic ? options.llm : undefined,
      llmCache: options.semantic ? options.llmCache : undefined,
    },
    [...A_LAYER_ENRICHERS, ...B_LAYER_ENRICHERS, ...C_LAYER_ENRICHERS, ...D_LAYER_ENRICHERS]
  );

  const result: SyncResult = {
    filesAnalyzed: currentPaths.size,
    filesUnchanged,
    filesCosmetic,
    filesStructural,
    filesAdded,
    filesDeleted,
    changes,
    updatedGraph: builder.build(),
    updatedFingerprints,
  };

  logger.info(
    `Sync complete: ${filesUnchanged} unchanged, ${filesCosmetic} cosmetic, ` +
    `${filesStructural} structural, ${filesAdded} added, ${filesDeleted} deleted`
  );

  return result;
}

/**
 * Rebuild graph nodes for a single file.
 * Removes old nodes for this file, then re-adds them via the shared builder
 * (contains/imports/exports + cross-file calls/inherits/symbol resolution).
 */
function rebuildGraphForFile(
  builder: KnowledgeGraphBuilder,
  filePath: string,
  fp: FileFingerprint,
  allFingerprints: Record<string, FileFingerprint>
): void {
  // Remove old nodes for this file first
  removeFileFromGraph(builder, filePath);
  addFileToGraph(builder, filePath, fp, allFingerprints, new Set(Object.keys(allFingerprints)));
}

/**
 * Remove all nodes associated with a file path from the graph.
 */
function removeFileFromGraph(builder: KnowledgeGraphBuilder, filePath: string): void {
  // Collect all node IDs associated with this file
  const nodesToRemove: string[] = [];
  const graph = builder.build();
  for (const node of graph.nodes) {
    if (node.filePath === filePath) {
      nodesToRemove.push(node.id);
    }
  }

  // Remove nodes and their edges
  for (const nodeId of nodesToRemove) {
    builder.removeEdgesByNode(nodeId);
    builder.removeNode(nodeId);
  }

  // Also remove the file node itself and its edges
  const fileNodeId = `file:${filePath}`;
  builder.removeEdgesByNode(fileNodeId);
  builder.removeNode(fileNodeId);
}
