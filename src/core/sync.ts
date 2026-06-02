import { scanRepo } from './repo-scanner.js';
import { computeFingerprint, classifyChange } from './fingerprint.js';
import { KnowledgeGraphBuilder, mergeGraphs } from './knowledge-graph.js';
import type {
  FileFingerprint,
  KnowledgeGraph,
  ChangeAnalysis,
  ChangeLevel,
} from './types.js';
import { MemoryMiddleware } from './memory.js';
import { readFile } from 'fs/promises';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('sync');

export interface SyncOptions {
  repoPath: string;
  forceFull?: boolean;
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
      rebuildGraphForFile(builder, filePath, newFp);
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
      rebuildGraphForFile(builder, filePath, newFp);
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
        rebuildGraphForFile(builder, filePath, newFp);
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
 * Removes old nodes for this file, then adds new ones.
 */
function rebuildGraphForFile(
  builder: KnowledgeGraphBuilder,
  filePath: string,
  fp: FileFingerprint
): void {
  // Remove old nodes for this file first
  removeFileFromGraph(builder, filePath);

  // Add file node
  builder.addNode({
    id: `file:${filePath}`,
    type: 'file',
    name: filePath.split('/').pop() || filePath,
    filePath,
  });

  // Add function nodes
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

  // Add class nodes
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

  // Add import edges
  for (const imp of fp.imports) {
    builder.addEdge(`file:${filePath}`, `module:${imp.source}`, 'imports', 0.7);
  }

  // Add export edges (file exports a symbol)
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
