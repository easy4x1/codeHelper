import type { KnowledgeGraph, GraphNode, GraphEdge } from './types.js';

/**
 * Indexed Knowledge Graph Builder
 *
 * Maintains multiple indexes for O(1) or O(degree) queries:
 * - nodesByType: type -> GraphNode[]
 * - edgesBySource: nodeId -> GraphEdge[]
 * - edgesByTarget: nodeId -> GraphEdge[]
 */
export class KnowledgeGraphBuilder {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();

  // Indexes
  private nodesByType = new Map<GraphNode['type'], GraphNode[]>();
  private edgesBySource = new Map<string, GraphEdge[]>();
  private edgesByTarget = new Map<string, GraphEdge[]>();

  addNode(node: Omit<GraphNode, 'id'> & { id: string }): void {
    if (this.nodes.has(node.id)) {
      return;
    }
    const cloned = { ...node };
    this.nodes.set(node.id, cloned);

    // Update type index
    const typeList = this.nodesByType.get(cloned.type) ?? [];
    typeList.push(cloned);
    this.nodesByType.set(cloned.type, typeList);
  }

  addEdge(source: string, target: string, type: GraphEdge['type'], weight: number): void {
    const id = `${source}--${type}--${target}`;
    if (this.edges.has(id)) {
      return;
    }
    const edge: GraphEdge = { id, source, target, type, weight };
    this.edges.set(id, edge);

    // Update source index
    const srcList = this.edgesBySource.get(source) ?? [];
    srcList.push(edge);
    this.edgesBySource.set(source, srcList);

    // Update target index
    const tgtList = this.edgesByTarget.get(target) ?? [];
    tgtList.push(edge);
    this.edgesByTarget.set(target, tgtList);
  }

  findNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  removeNode(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node) {
      return false;
    }

    // Remove all connected edges to prevent orphans
    this.removeEdgesByNode(id);

    // Remove from type index
    const typeList = this.nodesByType.get(node.type);
    if (typeList) {
      const filtered = typeList.filter(n => n.id !== id);
      if (filtered.length === 0) {
        this.nodesByType.delete(node.type);
      } else {
        this.nodesByType.set(node.type, filtered);
      }
    }

    return this.nodes.delete(id);
  }

  removeEdge(id: string): boolean {
    const edge = this.edges.get(id);
    if (!edge) {
      return false;
    }

    // Remove from source index
    const srcList = this.edgesBySource.get(edge.source);
    if (srcList) {
      const filtered = srcList.filter(e => e.id !== id);
      if (filtered.length === 0) {
        this.edgesBySource.delete(edge.source);
      } else {
        this.edgesBySource.set(edge.source, filtered);
      }
    }

    // Remove from target index
    const tgtList = this.edgesByTarget.get(edge.target);
    if (tgtList) {
      const filtered = tgtList.filter(e => e.id !== id);
      if (filtered.length === 0) {
        this.edgesByTarget.delete(edge.target);
      } else {
        this.edgesByTarget.set(edge.target, filtered);
      }
    }

    return this.edges.delete(id);
  }

  removeEdgesByNode(nodeId: string): number {
    let removed = 0;

    // Collect edges to remove from indexes first
    const edgesToRemove: string[] = [];
    const srcEdges = this.edgesBySource.get(nodeId) ?? [];
    const tgtEdges = this.edgesByTarget.get(nodeId) ?? [];

    for (const edge of srcEdges) {
      edgesToRemove.push(edge.id);
    }
    for (const edge of tgtEdges) {
      if (!edgesToRemove.includes(edge.id)) {
        edgesToRemove.push(edge.id);
      }
    }

    for (const id of edgesToRemove) {
      if (this.removeEdge(id)) {
        removed++;
      }
    }

    return removed;
  }

  /**
   * Get outgoing edges from a node (O(1) via index).
   */
  getEdgesBySource(nodeId: string): GraphEdge[] {
    return [...(this.edgesBySource.get(nodeId) ?? [])];
  }

  /**
   * Get incoming edges to a node (O(1) via index).
   */
  getEdgesByTarget(nodeId: string): GraphEdge[] {
    return [...(this.edgesByTarget.get(nodeId) ?? [])];
  }

  findNeighbors(nodeId: string, edgeType?: string): GraphNode[] {
    const neighborIds = new Set<string>();

    // Use edge indexes instead of scanning all edges
    const outgoing = this.edgesBySource.get(nodeId) ?? [];
    for (const edge of outgoing) {
      if (!edgeType || edge.type === edgeType) {
        neighborIds.add(edge.target);
      }
    }

    const incoming = this.edgesByTarget.get(nodeId) ?? [];
    for (const edge of incoming) {
      if (!edgeType || edge.type === edgeType) {
        neighborIds.add(edge.source);
      }
    }

    return Array.from(neighborIds)
      .map(id => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined);
  }

  getNodesByType(type: GraphNode['type']): GraphNode[] {
    // O(1) lookup from index
    return [...(this.nodesByType.get(type) ?? [])];
  }

  getEdgeCount(): number {
    return this.edges.size;
  }

  getNodeCount(): number {
    return this.nodes.size;
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
      builder.addNode(node);
    }
    for (const edge of graph.edges) {
      builder.addEdge(edge.source, edge.target, edge.type, edge.weight);
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
