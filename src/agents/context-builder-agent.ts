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

    // Two traces with different goals:
    //  - Recall ('both'): cast a wide net for LLM context. Over-inclusion is the
    //    safe failure mode here — a missed file means an incomplete fix.
    //  - Root cause ('upstream'): precision matters. Only nodes whose fault would
    //    actually propagate *to* the entry point are genuine causes, so we gate on
    //    the propagation rules instead of reusing the wide recall set (which would
    //    pollute candidates with downstream-reachable-but-causally-unrelated nodes).
    const recallTrace = engine.trace(nodeIds, {
      direction: 'both',
      maxDepth,
      minEdgeWeight: 0.5,
      includeTests: false,
    });

    const rootCauseTrace = engine.trace(nodeIds, {
      direction: 'upstream',
      maxDepth,
      minEdgeWeight: 0.5,
      includeTests: false,
    });

    const uniqueIds = new Set<string>(nodeIds);
    for (const affected of recallTrace.affectedNodes) {
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
      recallTrace.affectedNodes.length > 0
        ? Math.max(...recallTrace.affectedNodes.map(n => n.impactProbability))
        : 0;

    return {
      recalledNodes: contextNodes,
      recalledCount: contextNodes.length,
      nodes: contextNodes,
      nodeCount: contextNodes.length,
      propagationSummary: {
        entryPoints: recallTrace.entryPoints.length,
        affectedNodes: recallTrace.affectedNodes.length,
        maxImpactProbability,
      },
      // Root-cause detail comes from the precise upstream trace; affectedNodes
      // retains the wide recall set for impact context.
      propagationResult: {
        affectedNodes: recallTrace.affectedNodes,
        rootCauseCandidates: rootCauseTrace.rootCauseCandidates,
      },
    };
  }
}
