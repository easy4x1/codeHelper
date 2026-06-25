import { BaseAgent } from './base-agent.js';
import { MemoryMiddleware } from '../core/memory.js';
import { KnowledgeGraphBuilder } from '../core/knowledge-graph.js';
import { PropagationEngine } from '../core/propagation.js';
import { contextBuilderContextSchema, parseContext, type AgentInput, type GraphNode } from '../core/types.js';

export class ContextBuilderAgent extends BaseAgent {
  constructor(private memory: MemoryMiddleware) {
    super('context-builder');
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const { nodeIds, maxPropagationDepth } = parseContext(input.context, contextBuilderContextSchema);
    const graph = this.memory.getKnowledgeGraph();

    const builder = KnowledgeGraphBuilder.fromGraph(graph);
    const engine = new PropagationEngine(builder);

    const maxDepth = maxPropagationDepth ?? 3;

    const traceResult = engine.trace(nodeIds, {
      direction: 'both',
      maxDepth,
      minEdgeWeight: 0.5,
      includeTests: false,
    });

    const uniqueIds = new Set<string>(nodeIds);
    for (const affected of traceResult.affectedNodes) {
      uniqueIds.add(affected.nodeId);
    }

    const contextNodes: GraphNode[] = [];
    for (const id of uniqueIds) {
      const node = builder.findNode(id);
      if (node) {
        contextNodes.push(node);
      }
    }

    const maxImpactProbability =
      traceResult.affectedNodes.length > 0
        ? Math.max(...traceResult.affectedNodes.map(n => n.impactProbability))
        : 0;

    return {
      recalledNodes: contextNodes,
      recalledCount: contextNodes.length,
      nodes: contextNodes,
      nodeCount: contextNodes.length,
      propagationSummary: {
        entryPoints: traceResult.entryPoints.length,
        affectedNodes: traceResult.affectedNodes.length,
        maxImpactProbability,
      },
      // Full propagation detail for downstream root-cause analysis.
      propagationResult: {
        affectedNodes: traceResult.affectedNodes,
        rootCauseCandidates: traceResult.rootCauseCandidates,
      },
    };
  }
}
