import type { KnowledgeGraph, GraphNode, GraphEdge } from './types.js';

export class KnowledgeGraphBuilder {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();

  addNode(node: Omit<GraphNode, 'id'> & { id: string }): void {
    this.nodes.set(node.id, { ...node });
  }

  addEdge(source: string, target: string, type: GraphEdge['type'], weight: number): void {
    const id = `${source}--${type}--${target}`;
    this.edges.set(id, { id, source, target, type, weight });
  }

  findNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  findNeighbors(nodeId: string, edgeType?: string): GraphNode[] {
    const neighborIds = new Set<string>();
    for (const edge of this.edges.values()) {
      if (edge.source === nodeId && (!edgeType || edge.type === edgeType)) {
        neighborIds.add(edge.target);
      }
      if (edge.target === nodeId && (!edgeType || edge.type === edgeType)) {
        neighborIds.add(edge.source);
      }
    }
    return Array.from(neighborIds)
      .map(id => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined);
  }

  getNodesByType(type: GraphNode['type']): GraphNode[] {
    return Array.from(this.nodes.values()).filter(n => n.type === type);
  }

  build(): KnowledgeGraph {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    };
  }

  static fromGraph(graph: KnowledgeGraph): KnowledgeGraphBuilder {
    const builder = new KnowledgeGraphBuilder();
    for (const node of graph.nodes) {
      builder.nodes.set(node.id, node);
    }
    for (const edge of graph.edges) {
      builder.edges.set(edge.id, edge);
    }
    return builder;
  }
}

export function mergeGraphs(base: KnowledgeGraph, updates: KnowledgeGraph): KnowledgeGraph {
  const builder = KnowledgeGraphBuilder.fromGraph(base);

  for (const node of updates.nodes) {
    builder.addNode(node);
  }
  for (const edge of updates.edges) {
    builder.addEdge(edge.source, edge.target, edge.type, edge.weight);
  }

  return builder.build();
}
