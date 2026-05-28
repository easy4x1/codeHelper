import { BaseAgent } from './base-agent.js';
import { MemoryMiddleware } from '../core/memory.js';
import type { AgentInput, GraphNode } from '../core/types.js';

export class ContextBuilderAgent extends BaseAgent {
  constructor(private memory: MemoryMiddleware) {
    super('context-builder');
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const nodeIds = input.context.nodeIds as string[] || [];
    const graph = this.memory.getKnowledgeGraph();
    const contextNodes: GraphNode[] = [];

    for (const nodeId of nodeIds) {
      const node = graph.nodes.find(n => n.id === nodeId);
      if (!node) continue;

      contextNodes.push(node);

      // Add neighbors (callers, callees, containers)
      for (const edge of graph.edges) {
        if (edge.source === nodeId || edge.target === nodeId) {
          const neighborId = edge.source === nodeId ? edge.target : edge.source;
          const neighbor = graph.nodes.find(n => n.id === neighborId);
          if (neighbor && !contextNodes.find(n => n.id === neighbor.id)) {
            contextNodes.push(neighbor);
          }
        }
      }
    }

    return {
      nodes: contextNodes,
      nodeCount: contextNodes.length,
    };
  }
}
