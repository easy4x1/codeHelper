import type { KnowledgeGraphBuilder } from './knowledge-graph.js';
import type {
  PropagationOptions, PropagationResult, AffectedNode,
  RootCauseCandidate, PropagationPath, EdgeType,
  GraphEdge, GraphNode,
} from './types.js';

export interface PropagationRule {
  propagateFromSource: boolean;
  propagateFromTarget: boolean;
}

/**
 * Maps each edge type to its fault propagation behavior.
 *
 * - propagateFromSource: does a fault in the source node affect the target?
 * - propagateFromTarget: does a fault in the target node affect the source?
 */
export const PROPAGATION_RULES: Record<EdgeType, PropagationRule> = {
  // Structural containment: parent fault affects child
  contains: { propagateFromSource: true, propagateFromTarget: false },

  // Call graph: called function fault affects caller
  calls: { propagateFromSource: false, propagateFromTarget: true },

  // Imports: imported module fault affects importer
  imports: { propagateFromSource: false, propagateFromTarget: true },

  // Inheritance: parent class fault affects child
  inherits: { propagateFromSource: false, propagateFromTarget: true },

  // Implementation: interface fault affects implementer
  implements: { propagateFromSource: false, propagateFromTarget: true },

  // Exports: exporter fault affects exportee (symmetric to imports)
  exports: { propagateFromSource: false, propagateFromTarget: true },

  // Pub/sub: publisher fault affects subscriber
  subscribes: { propagateFromSource: false, propagateFromTarget: true },
  publishes: { propagateFromSource: true, propagateFromTarget: false },

  // Middleware: middleware fault affects downstream
  middleware: { propagateFromSource: true, propagateFromTarget: false },

  // Data flow: source fault affects reader; reader fault does not affect source
  reads_from: { propagateFromSource: true, propagateFromTarget: false },
  writes_to: { propagateFromSource: false, propagateFromTarget: true },

  // Transformation: upstream fault affects downstream
  transforms: { propagateFromSource: true, propagateFromTarget: false },

  // Validation: validator fault affects validated
  validates: { propagateFromSource: true, propagateFromTarget: false },

  // Dependency: dependency fault affects dependent
  depends_on: { propagateFromSource: false, propagateFromTarget: true },

  // Testing: test failure does not propagate to code under test by default
  tested_by: { propagateFromSource: false, propagateFromTarget: false },

  // Configuration: config fault affects consumer
  configures: { propagateFromSource: true, propagateFromTarget: false },

  // Generic relations: bidirectional propagation
  related: { propagateFromSource: true, propagateFromTarget: true },
  similar_to: { propagateFromSource: true, propagateFromTarget: true },

  // Deployment: deployed artifact fault affects deployment target
  deploys: { propagateFromSource: true, propagateFromTarget: false },

  // Service: service fault affects server
  serves: { propagateFromSource: true, propagateFromTarget: false },

  // Provisioning: provisioned resource fault affects provisioner
  provisions: { propagateFromSource: false, propagateFromTarget: true },

  // Triggering: trigger source fault affects triggered
  triggers: { propagateFromSource: true, propagateFromTarget: false },

  // Migration: migration fault affects source/target
  migrates: { propagateFromSource: true, propagateFromTarget: true },

  // Documentation: documented entity fault affects docs
  documents: { propagateFromSource: true, propagateFromTarget: false },

  // Routing: router fault affects routed endpoint
  routes: { propagateFromSource: true, propagateFromTarget: false },

  // Schema: schema definition fault affects schema user
  defines_schema: { propagateFromSource: true, propagateFromTarget: false },

  // Fix/mitigation: fix does not propagate to fault (it's a solution)
  fixes: { propagateFromSource: false, propagateFromTarget: false },
  mitigates: { propagateFromSource: false, propagateFromTarget: false },

  // Fault relation: bidirectional
  relates_to_fault: { propagateFromSource: true, propagateFromTarget: true },

  // Suggestion: suggestion does not propagate
  suggests: { propagateFromSource: false, propagateFromTarget: false },

  // Learning: learned pattern does not propagate
  learned_from: { propagateFromSource: false, propagateFromTarget: false },
};

function isTestFile(node: GraphNode): boolean {
  if (!node.filePath) return false;
  return /\.(test|spec)\./.test(node.filePath);
}

export class PropagationEngine {
  constructor(private graphBuilder: KnowledgeGraphBuilder) {}

  trace(entryPoints: string[], options: PropagationOptions): PropagationResult {
    const visited = new Map<string, AffectedNode>();
    const queue: { nodeId: string; probability: number; distance: number; path: string[] }[] = [];
    const propagationPaths: PropagationPath[] = [];

    // Initialize queue with entry points
    for (const entryPoint of entryPoints) {
      const node = this.graphBuilder.findNode(entryPoint);
      if (!node) continue;
      if (!options.includeTests && isTestFile(node)) continue;

      queue.push({
        nodeId: entryPoint,
        probability: 1.0,
        distance: 0,
        path: [entryPoint],
      });

      visited.set(entryPoint, {
        nodeId: entryPoint,
        nodeType: node.type,
        impactProbability: 1.0,
        distance: 0,
        path: [entryPoint],
      });
    }

    let head = 0;
    while (head < queue.length) {
      const current = queue[head++];

      if (current.distance >= options.maxDepth) {
        continue;
      }

      const edges = this.getNextEdges(current.nodeId, options.direction);
      for (const edge of edges) {
        if (edge.weight < options.minEdgeWeight) {
          continue;
        }

        const nextNodeId = this.getNextNodeId(current.nodeId, edge);
        if (!nextNodeId) continue;

        const nextNode = this.graphBuilder.findNode(nextNodeId);
        if (!nextNode) continue;

        if (!options.includeTests && isTestFile(nextNode)) {
          continue;
        }

        const newProbability = current.probability * edge.weight;
        const newDistance = current.distance + 1;
        const newPath = [...current.path, nextNodeId];

        const existing = visited.get(nextNodeId);
        if (!existing || newProbability > existing.impactProbability) {
          visited.set(nextNodeId, {
            nodeId: nextNodeId,
            nodeType: nextNode.type,
            impactProbability: newProbability,
            distance: newDistance,
            path: newPath,
          });

          propagationPaths.push({
            fromNodeId: current.nodeId,
            toNodeId: nextNodeId,
            edgeType: edge.type,
            weight: edge.weight,
          });

          queue.push({
            nodeId: nextNodeId,
            probability: newProbability,
            distance: newDistance,
            path: newPath,
          });
        }
      }
    }

    // Remove entry points from affected nodes
    const affectedNodes = Array.from(visited.values())
      .filter(n => !entryPoints.includes(n.nodeId))
      .sort((a, b) => b.impactProbability - a.impactProbability);

    // Generate root cause candidates from upstream-most nodes
    const rootCauseCandidates = this.generateRootCauseCandidates(affectedNodes, propagationPaths, entryPoints);

    return {
      entryPoints,
      affectedNodes,
      rootCauseCandidates,
      propagationPaths,
    };
  }

  private getNextEdges(nodeId: string, direction: PropagationOptions['direction']): GraphEdge[] {
    const result: GraphEdge[] = [];
    const seen = new Set<string>();

    const addEdge = (edge: GraphEdge) => {
      if (!seen.has(edge.id)) {
        seen.add(edge.id);
        result.push(edge);
      }
    };

    const outgoing = this.graphBuilder.getEdgesBySource(nodeId);
    const incoming = this.graphBuilder.getEdgesByTarget(nodeId);

    if (direction === 'upstream' || direction === 'both') {
      // Incoming edges: traverse reverse (target -> source) if fault in target affects source
      for (const edge of incoming) {
        const rule = PROPAGATION_RULES[edge.type];
        if (rule.propagateFromTarget) {
          addEdge(edge);
        }
      }
    }

    if (direction === 'downstream' || direction === 'both') {
      // Outgoing edges: traverse natural direction (source -> target)
      for (const edge of outgoing) {
        addEdge(edge);
      }
    }

    if (direction === 'upstream') {
      // Outgoing edges: traverse natural direction if fault in source affects target
      for (const edge of outgoing) {
        const rule = PROPAGATION_RULES[edge.type];
        if (rule.propagateFromSource) {
          addEdge(edge);
        }
      }
    }

    return result;
  }

  private getNextNodeId(currentNodeId: string, edge: GraphEdge): string | null {
    if (edge.source === currentNodeId) {
      // outgoing edge: natural direction
      return edge.target;
    } else if (edge.target === currentNodeId) {
      // incoming edge: reverse direction
      return edge.source;
    }
    return null;
  }

  private generateRootCauseCandidates(
    affectedNodes: AffectedNode[],
    propagationPaths: PropagationPath[],
    entryPoints: string[],
  ): RootCauseCandidate[] {
    // Nodes that are affected but have no outgoing propagation paths
    // (i.e., they are "leaves" in the propagation graph, upstream-most)
    const nodesWithOutgoingPaths = new Set(propagationPaths.map(p => p.fromNodeId));
    const entrySet = new Set(entryPoints);

    const candidates: RootCauseCandidate[] = [];
    for (const node of affectedNodes) {
      if (!nodesWithOutgoingPaths.has(node.nodeId) && !entrySet.has(node.nodeId)) {
        candidates.push({
          nodeId: node.nodeId,
          nodeType: node.nodeType,
          confidence: node.impactProbability,
          reasoning: `Upstream-most affected node at distance ${node.distance} with impact probability ${node.impactProbability.toFixed(2)}`,
        });
      }
    }

    // Sort by confidence descending
    candidates.sort((a, b) => b.confidence - a.confidence);

    return candidates;
  }
}
