import { KnowledgeGraphBuilder } from './knowledge-graph.js';
import type { Finding, SolutionPlan, FaultPattern, FixPattern } from './types.js';

const MAX_NAME_LEN = 80;

function truncate(text: string, len = MAX_NAME_LEN): string {
  return text.length > len ? text.slice(0, len - 1) + '…' : text;
}

/**
 * Normalize a raw node reference to a graph node id.
 * Finding.nodeIds may contain graph node ids (file:/function:/class:) or plain
 * file paths emitted by the LLM analyzer. Plain file paths are mapped to the
 * canonical file node id.
 */
function toGraphNodeId(raw: string): string {
  if (
    raw.startsWith('file:') ||
    raw.startsWith('function:') ||
    raw.startsWith('class:') ||
    raw.startsWith('module:') ||
    raw.startsWith('config:') ||
    raw.startsWith('service:') ||
    raw.startsWith('schema:') ||
    raw.startsWith('endpoint:') ||
    raw.startsWith('table:') ||
    raw.startsWith('resource:') ||
    raw.startsWith('pipeline:') ||
    raw.startsWith('document:') ||
    raw.startsWith('concept:')
  ) {
    return raw;
  }
  return `file:${raw}`;
}

function inferFaultSeverity(findingType: Finding['type']): string {
  switch (findingType) {
    case 'fault':
      return 'major';
    case 'style':
      return 'minor';
    case 'insight':
      return 'info';
    default:
      return 'info';
  }
}

function inferFixType(change: SolutionPlan['changes'][number]): string {
  const { filePath, changeType } = change;
  const lower = filePath.toLowerCase();
  if (
    lower.includes('package') ||
    lower.includes('yarn.lock') ||
    lower.includes('pnpm-lock') ||
    lower.includes('poetry.lock') ||
    lower.includes('cargo.lock')
  ) {
    return 'dependency_update';
  }
  if (
    lower.includes('config') ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.yml') ||
    lower.endsWith('.json') ||
    lower.endsWith('.toml') ||
    lower.endsWith('.ini')
  ) {
    return 'config_change';
  }
  if (changeType === 'delete' || changeType === 'rename') {
    return 'refactor';
  }
  return 'code_change';
}

/**
 * Write findings into the graph as fault nodes.
 * Only `fault`/`style` findings become graph faults; `insight` findings are
 * currently skipped because they are too low-signal.
 */
export function recordFindingsAsFaults(
  builder: KnowledgeGraphBuilder,
  findings: Finding[]
): void {
  for (const finding of findings) {
    if (finding.type !== 'fault' && finding.type !== 'style' && finding.type !== 'insight') {
      continue;
    }

    const faultId = `fault:${finding.id}`;
    builder.addNode({
      id: faultId,
      type: 'fault',
      name: truncate(finding.description),
      metadata: {
        description: finding.description,
        confidence: finding.confidence,
        severity: inferFaultSeverity(finding.type),
      },
    });

    for (const rawId of finding.nodeIds) {
      const nodeId = toGraphNodeId(rawId);
      if (builder.findNode(nodeId)) {
        builder.addEdge(nodeId, faultId, 'relates_to_fault', finding.confidence);
      }
    }
  }
}

/**
 * Write a solution plan into the graph as fix nodes.
 * Each file change becomes a fix node with a `fixes` edge to the target file.
 * When the related findings are provided, `mitigates` edges are also created
 * between the fix and the corresponding fault nodes.
 */
export function recordPlanAsFixes(
  builder: KnowledgeGraphBuilder,
  plan: SolutionPlan,
  relatedFindings?: Finding[]
): void {
  const planConfidence = plan.metadata.confidence;

  plan.changes.forEach((change, idx) => {
    const fileNodeId = `file:${change.filePath}`;
    if (!builder.findNode(fileNodeId)) {
      return;
    }

    const fixId = `fix:${plan.id}:${idx}`;
    builder.addNode({
      id: fixId,
      type: 'fix',
      name: truncate(change.description),
      filePath: change.filePath,
      metadata: {
        changeType: change.changeType,
        fixType: inferFixType(change),
        reasoning: change.reasoning,
        confidence: planConfidence,
      },
    });

    builder.addEdge(fixId, fileNodeId, 'fixes', planConfidence);

    if (relatedFindings) {
      for (const finding of relatedFindings) {
        if (finding.type !== 'fault' && finding.type !== 'style') {
          continue;
        }
        const faultId = `fault:${finding.id}`;
        if (builder.findNode(faultId)) {
          builder.addEdge(fixId, faultId, 'mitigates', Math.min(planConfidence, finding.confidence));
        }
      }
    }
  });
}

/**
 * Write learned patterns into the graph as pattern nodes.
 * Each pattern is linked back to its source nodes via `learned_from` edges.
 */
export function recordPatterns(
  builder: KnowledgeGraphBuilder,
  faultPatterns: FaultPattern[],
  fixPatterns: FixPattern[],
  sourceNodeIds: string[] = []
): void {
  const allPatterns = [
    ...faultPatterns.map(p => ({ ...p, kind: 'fault' as const })),
    ...fixPatterns.map(p => ({ ...p, kind: 'fix' as const })),
  ];

  for (const p of allPatterns) {
    const patternId = `pattern:${p.kind}:${p.id}`;
    builder.addNode({
      id: patternId,
      type: 'pattern',
      name: truncate(p.pattern),
      metadata: {
        language: p.language,
        frequency: p.frequency,
        kind: p.kind,
      },
    });

    for (const rawId of sourceNodeIds) {
      const nodeId = toGraphNodeId(rawId);
      if (builder.findNode(nodeId)) {
        builder.addEdge(patternId, nodeId, 'learned_from', Math.min(1, 0.5 + p.frequency * 0.1));
      }
    }
  }
}
