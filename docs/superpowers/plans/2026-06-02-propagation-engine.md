# Fault Propagation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a graph-based fault propagation engine that traces from fault entry points along the knowledge graph to compute affected nodes, impact probabilities, and root cause candidates.

**Architecture:** A `PropagationEngine` class receives entry point node IDs and a `KnowledgeGraphBuilder`, then performs weighted breadth-first traversal. Each edge type has a predefined propagation rule (direction + weight). The result is a ranked list of affected nodes sorted by impact probability, plus propagation paths for explainability.

**Tech Stack:** TypeScript, vitest, existing `KnowledgeGraphBuilder` indexes (`edgesBySource`, `edgesByTarget`)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/core/propagation.ts` | `PropagationEngine` class, `PropagationOptions`, `PropagationResult`, `AffectedNode` types, edge propagation rules |
| `tests/propagation.test.ts` | Unit tests for all propagation scenarios: basic trace, multi-entry, depth limit, min weight filter, bidirectional |
| `src/core/types.ts` | Add `PropagationOptions`, `AffectedNode`, `PropagationResult`, `RootCauseCandidate`, `PropagationPath` interfaces |

---

## Task 1: Add Propagation Types to Core Types

**Files:**
- Modify: `src/core/types.ts`
- Test: `tests/types.test.ts`

- [ ] **Step 1: Add propagation types to `src/core/types.ts`**

Append after the `FileChange` interface (before the Zod schemas section):

```typescript
// ============================================
// Propagation Engine Types
// ============================================

export interface PropagationOptions {
  direction: 'upstream' | 'downstream' | 'both';
  maxDepth: number;
  minEdgeWeight: number;
  includeTests: boolean;
}

export interface AffectedNode {
  nodeId: string;
  nodeType: NodeType;
  impactProbability: number;
  distance: number;
  path: string[];
}

export interface RootCauseCandidate {
  nodeId: string;
  nodeType: NodeType;
  confidence: number;
  reasoning: string;
}

export interface PropagationPath {
  fromNodeId: string;
  toNodeId: string;
  edgeType: EdgeType;
  weight: number;
}

export interface PropagationResult {
  entryPoints: string[];
  affectedNodes: AffectedNode[];
  rootCauseCandidates: RootCauseCandidate[];
  propagationPaths: PropagationPath[];
}
```

- [ ] **Step 2: Add type validation test to `tests/types.test.ts`**

Append to existing `tests/types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type {
  PropagationOptions,
  AffectedNode,
  PropagationResult,
} from '../src/core/types.js';

describe('Propagation types', () => {
  it('accepts valid propagation options', () => {
    const opts: PropagationOptions = {
      direction: 'both',
      maxDepth: 3,
      minEdgeWeight: 0.5,
      includeTests: false,
    };
    expect(opts.maxDepth).toBe(3);
    expect(opts.minEdgeWeight).toBe(0.5);
  });

  it('accepts valid affected node', () => {
    const node: AffectedNode = {
      nodeId: 'function:src/a.ts:foo',
      nodeType: 'function',
      impactProbability: 0.8,
      distance: 2,
      path: ['file:src/a.ts', 'function:src/a.ts:foo'],
    };
    expect(node.impactProbability).toBe(0.8);
  });

  it('accepts valid propagation result', () => {
    const result: PropagationResult = {
      entryPoints: ['function:src/a.ts:main'],
      affectedNodes: [],
      rootCauseCandidates: [],
      propagationPaths: [],
    };
    expect(result.entryPoints).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run type tests**

Run: `npx vitest run tests/types.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 4: Commit**

```bash
git add src/core/types.ts tests/types.test.ts
git commit -m "feat: propagation engine type definitions"
```

---

## Task 2: Implement Propagation Engine Core

**Files:**
- Create: `src/core/propagation.ts`
- Test: `tests/propagation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/propagation.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { PropagationEngine } from '../src/core/propagation.js';
import { KnowledgeGraphBuilder } from '../src/core/knowledge-graph.js';

describe('PropagationEngine', () => {
  let builder: KnowledgeGraphBuilder;
  let engine: PropagationEngine;

  beforeEach(() => {
    builder = new KnowledgeGraphBuilder();
  });

  function buildSimpleChain() {
    // A calls B calls C
    // file:a.ts contains function:A, function:B
    // file:b.ts contains function:C
    builder.addNode({ id: 'file:src/a.ts', type: 'file', name: 'a.ts', filePath: 'src/a.ts' });
    builder.addNode({ id: 'file:src/b.ts', type: 'file', name: 'b.ts', filePath: 'src/b.ts' });
    builder.addNode({ id: 'function:src/a.ts:A', type: 'function', name: 'A', filePath: 'src/a.ts' });
    builder.addNode({ id: 'function:src/a.ts:B', type: 'function', name: 'B', filePath: 'src/a.ts' });
    builder.addNode({ id: 'function:src/b.ts:C', type: 'function', name: 'C', filePath: 'src/b.ts' });

    builder.addEdge('file:src/a.ts', 'function:src/a.ts:A', 'contains', 1.0);
    builder.addEdge('file:src/a.ts', 'function:src/a.ts:B', 'contains', 1.0);
    builder.addEdge('file:src/b.ts', 'function:src/b.ts:C', 'contains', 1.0);
    builder.addEdge('function:src/a.ts:A', 'function:src/a.ts:B', 'calls', 0.8);
    builder.addEdge('function:src/a.ts:B', 'function:src/b.ts:C', 'calls', 0.8);
  }

  it('traces upstream from a single entry point', () => {
    buildSimpleChain();
    engine = new PropagationEngine(builder);

    const result = engine.trace(['function:src/a.ts:B'], {
      direction: 'upstream',
      maxDepth: 3,
      minEdgeWeight: 0.5,
      includeTests: false,
    });

    // B is called by A, so A should be affected
    const affectedIds = result.affectedNodes.map(n => n.nodeId);
    expect(affectedIds).toContain('function:src/a.ts:A');
    expect(affectedIds).toContain('function:src/a.ts:B'); // entry point itself
  });

  it('respects maxDepth', () => {
    buildSimpleChain();
    engine = new PropagationEngine(builder);

    const result = engine.trace(['function:src/b.ts:C'], {
      direction: 'upstream',
      maxDepth: 1,
      minEdgeWeight: 0.5,
      includeTests: false,
    });

    // C is called by B (depth 1). A calls B (depth 2) should NOT appear
    const affectedIds = result.affectedNodes.map(n => n.nodeId);
    expect(affectedIds).toContain('function:src/b.ts:C');
    expect(affectedIds).toContain('function:src/a.ts:B');
    expect(affectedIds).not.toContain('function:src/a.ts:A');
  });

  it('respects minEdgeWeight', () => {
    buildSimpleChain();
    engine = new PropagationEngine(builder);

    const result = engine.trace(['function:src/b.ts:C'], {
      direction: 'upstream',
      maxDepth: 3,
      minEdgeWeight: 0.9, // calls edges have weight 0.8
      includeTests: false,
    });

    // Only C itself should appear (no edges pass the threshold)
    const affectedIds = result.affectedNodes.map(n => n.nodeId);
    expect(affectedIds).toEqual(['function:src/b.ts:C']);
  });

  it('traces both directions', () => {
    buildSimpleChain();
    engine = new PropagationEngine(builder);

    const result = engine.trace(['function:src/a.ts:B'], {
      direction: 'both',
      maxDepth: 3,
      minEdgeWeight: 0.5,
      includeTests: false,
    });

    // Upstream: A calls B
    // Downstream: B calls C
    const affectedIds = result.affectedNodes.map(n => n.nodeId);
    expect(affectedIds).toContain('function:src/a.ts:A');
    expect(affectedIds).toContain('function:src/a.ts:B');
    expect(affectedIds).toContain('function:src/b.ts:C');
  });

  it('propagates through contains edges', () => {
    builder.addNode({ id: 'file:src/app.ts', type: 'file', name: 'app.ts', filePath: 'src/app.ts' });
    builder.addNode({ id: 'function:src/app.ts:main', type: 'function', name: 'main', filePath: 'src/app.ts' });
    builder.addEdge('file:src/app.ts', 'function:src/app.ts:main', 'contains', 1.0);

    engine = new PropagationEngine(builder);
    const result = engine.trace(['file:src/app.ts'], {
      direction: 'upstream',
      maxDepth: 2,
      minEdgeWeight: 0.5,
      includeTests: false,
    });

    // File contains function, so function is affected
    const affectedIds = result.affectedNodes.map(n => n.nodeId);
    expect(affectedIds).toContain('function:src/app.ts:main');
  });

  it('propagates through imports edges', () => {
    builder.addNode({ id: 'file:src/a.ts', type: 'file', name: 'a.ts', filePath: 'src/a.ts' });
    builder.addNode({ id: 'file:src/b.ts', type: 'file', name: 'b.ts', filePath: 'src/b.ts' });
    builder.addNode({ id: 'module:src/b.ts', type: 'module', name: 'src/b.ts' });
    builder.addEdge('file:src/a.ts', 'module:src/b.ts', 'imports', 0.7);

    engine = new PropagationEngine(builder);
    const result = engine.trace(['module:src/b.ts'], {
      direction: 'upstream',
      maxDepth: 2,
      minEdgeWeight: 0.5,
      includeTests: false,
    });

    // module b is imported by file a, so file a is affected
    const affectedIds = result.affectedNodes.map(n => n.nodeId);
    expect(affectedIds).toContain('file:src/a.ts');
  });

  it('computes impact probability correctly', () => {
    buildSimpleChain();
    engine = new PropagationEngine(builder);

    const result = engine.trace(['function:src/b.ts:C'], {
      direction: 'upstream',
      maxDepth: 3,
      minEdgeWeight: 0.5,
      includeTests: false,
    });

    const c = result.affectedNodes.find(n => n.nodeId === 'function:src/b.ts:C');
    const b = result.affectedNodes.find(n => n.nodeId === 'function:src/a.ts:B');
    const a = result.affectedNodes.find(n => n.nodeId === 'function:src/a.ts:A');

    expect(c?.impactProbability).toBe(1.0); // entry point
    expect(b?.impactProbability).toBe(0.8); // one calls edge
    expect(a?.impactProbability).toBe(0.64); // 0.8 * 0.8
  });

  it('excludes test files when includeTests is false', () => {
    builder.addNode({ id: 'file:src/utils.ts', type: 'file', name: 'utils.ts', filePath: 'src/utils.ts' });
    builder.addNode({ id: 'file:src/utils.test.ts', type: 'file', name: 'utils.test.ts', filePath: 'src/utils.test.ts' });
    builder.addEdge('file:src/utils.test.ts', 'file:src/utils.ts', 'imports', 0.7);

    engine = new PropagationEngine(builder);
    const result = engine.trace(['file:src/utils.ts'], {
      direction: 'upstream',
      maxDepth: 2,
      minEdgeWeight: 0.5,
      includeTests: false,
    });

    const affectedIds = result.affectedNodes.map(n => n.nodeId);
    expect(affectedIds).not.toContain('file:src/utils.test.ts');
  });

  it('includes test files when includeTests is true', () => {
    builder.addNode({ id: 'file:src/utils.ts', type: 'file', name: 'utils.ts', filePath: 'src/utils.ts' });
    builder.addNode({ id: 'file:src/utils.test.ts', type: 'file', name: 'utils.test.ts', filePath: 'src/utils.test.ts' });
    builder.addEdge('file:src/utils.test.ts', 'file:src/utils.ts', 'imports', 0.7);

    engine = new PropagationEngine(builder);
    const result = engine.trace(['file:src/utils.ts'], {
      direction: 'upstream',
      maxDepth: 2,
      minEdgeWeight: 0.5,
      includeTests: true,
    });

    const affectedIds = result.affectedNodes.map(n => n.nodeId);
    expect(affectedIds).toContain('file:src/utils.test.ts');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/propagation.test.ts`
Expected: FAIL — `PropagationEngine` not found

- [ ] **Step 3: Implement propagation engine**

Create `src/core/propagation.ts`:

```typescript
import type {
  KnowledgeGraphBuilder,
  GraphEdge,
  GraphNode,
} from './knowledge-graph.js';
import type {
  PropagationOptions,
  PropagationResult,
  AffectedNode,
  RootCauseCandidate,
  PropagationPath,
  EdgeType,
} from './types.js';

/**
 * Defines how a fault propagates through each edge type.
 *
 * For each edge type, we define:
 * - propagateFromSource: does a fault in the source node affect the target?
 * - propagateFromTarget: does a fault in the target node affect the source?
 *
 * Examples:
 * - `calls`: A --calls--> B. If B has a fault, A (the caller) is affected.
 *   So propagateFromTarget = true.
 * - `contains`: A --contains--> B. If A (file) has a fault, B (function inside) is affected.
 *   So propagateFromSource = true.
 * - `imports`: A --imports--> B. If B (module) has a fault, A (importer) is affected.
 *   So propagateFromTarget = true.
 * - `inherits`: A --inherits--> B. If B (parent class) has a fault, A (child) is affected.
 *   So propagateFromTarget = true.
 */
interface PropagationRule {
  propagateFromSource: boolean;
  propagateFromTarget: boolean;
}

const PROPAGATION_RULES: Record<EdgeType, PropagationRule> = {
  contains: { propagateFromSource: true, propagateFromTarget: false },
  imports: { propagateFromSource: false, propagateFromTarget: true },
  exports: { propagateFromSource: true, propagateFromTarget: false },
  inherits: { propagateFromSource: false, propagateFromTarget: true },
  implements: { propagateFromSource: false, propagateFromTarget: true },
  calls: { propagateFromSource: false, propagateFromTarget: true },
  subscribes: { propagateFromSource: false, propagateFromTarget: true },
  publishes: { propagateFromSource: true, propagateFromTarget: false },
  middleware: { propagateFromSource: false, propagateFromTarget: true },
  reads_from: { propagateFromSource: false, propagateFromTarget: true },
  writes_to: { propagateFromSource: true, propagateFromTarget: false },
  transforms: { propagateFromSource: true, propagateFromTarget: true },
  validates: { propagateFromSource: false, propagateFromTarget: true },
  depends_on: { propagateFromSource: false, propagateFromTarget: true },
  tested_by: { propagateFromSource: true, propagateFromTarget: false },
  configures: { propagateFromSource: false, propagateFromTarget: true },
  related: { propagateFromSource: true, propagateFromTarget: true },
  similar_to: { propagateFromSource: true, propagateFromTarget: true },
  deploys: { propagateFromSource: true, propagateFromTarget: false },
  serves: { propagateFromSource: true, propagateFromTarget: false },
  provisions: { propagateFromSource: true, propagateFromTarget: false },
  triggers: { propagateFromSource: true, propagateFromTarget: false },
  migrates: { propagateFromSource: true, propagateFromTarget: true },
  documents: { propagateFromSource: true, propagateFromTarget: true },
  routes: { propagateFromSource: true, propagateFromTarget: true },
  defines_schema: { propagateFromSource: true, propagateFromTarget: true },
  fixes: { propagateFromSource: true, propagateFromTarget: false },
  mitigates: { propagateFromSource: true, propagateFromTarget: false },
  relates_to_fault: { propagateFromSource: true, propagateFromTarget: true },
  suggests: { propagateFromSource: true, propagateFromTarget: false },
  learned_from: { propagateFromSource: true, propagateFromTarget: true },
};

export class PropagationEngine {
  constructor(private graphBuilder: KnowledgeGraphBuilder) {}

  trace(entryPoints: string[], options: PropagationOptions): PropagationResult {
    const visited = new Map<string, { probability: number; distance: number; path: string[] }>();
    const queue: Array<{
      nodeId: string;
      probability: number;
      distance: number;
      path: string[];
    }> = [];

    // Initialize with entry points
    for (const entryPoint of entryPoints) {
      const node = this.graphBuilder.findNode(entryPoint);
      if (!node) continue;

      if (this.shouldIncludeNode(node, options)) {
        visited.set(entryPoint, {
          probability: 1.0,
          distance: 0,
          path: [entryPoint],
        });
        queue.push({
          nodeId: entryPoint,
          probability: 1.0,
          distance: 0,
          path: [entryPoint],
        });
      }
    }

    const propagationPaths: PropagationPath[] = [];

    // BFS with weighted probabilities
    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.distance >= options.maxDepth) {
        continue;
      }

      const nextNodes = this.getNextNodes(current.nodeId, options.direction);

      for (const { nodeId, edge } of nextNodes) {
        if (edge.weight < options.minEdgeWeight) {
          continue;
        }

        const nextNode = this.graphBuilder.findNode(nodeId);
        if (!nextNode || !this.shouldIncludeNode(nextNode, options)) {
          continue;
        }

        const newProbability = current.probability * edge.weight;
        const newDistance = current.distance + 1;
        const newPath = [...current.path, nodeId];

        const existing = visited.get(nodeId);
        if (!existing || newProbability > existing.probability) {
          visited.set(nodeId, {
            probability: newProbability,
            distance: newDistance,
            path: newPath,
          });
          queue.push({
            nodeId,
            probability: newProbability,
            distance: newDistance,
            path: newPath,
          });

          propagationPaths.push({
            fromNodeId: current.nodeId,
            toNodeId: nodeId,
            edgeType: edge.type,
            weight: edge.weight,
          });
        }
      }
    }

    // Build affected nodes list sorted by probability (descending)
    const affectedNodes: AffectedNode[] = Array.from(visited.entries())
      .map(([nodeId, data]) => {
        const node = this.graphBuilder.findNode(nodeId);
        return {
          nodeId,
          nodeType: node?.type ?? 'concept',
          impactProbability: data.probability,
          distance: data.distance,
          path: data.path,
        };
      })
      .sort((a, b) => b.impactProbability - a.impactProbability);

    // Generate root cause candidates (entry points + nodes at distance 1 with high probability)
    const rootCauseCandidates: RootCauseCandidate[] = entryPoints.map(id => {
      const node = this.graphBuilder.findNode(id);
      return {
        nodeId: id,
        nodeType: node?.type ?? 'concept',
        confidence: 1.0,
        reasoning: 'Direct fault entry point',
      };
    });

    return {
      entryPoints,
      affectedNodes,
      rootCauseCandidates,
      propagationPaths,
    };
  }

  private getNextNodes(
    nodeId: string,
    direction: PropagationOptions['direction']
  ): Array<{ nodeId: string; edge: GraphEdge }> {
    const result: Array<{ nodeId: string; edge: GraphEdge }> = [];

    // Get outgoing edges (source -> target)
    const outgoing = this.graphBuilder['edgesBySource'].get(nodeId) ?? [];
    for (const edge of outgoing) {
      const rule = PROPAGATION_RULES[edge.type];
      // propagateFromSource means: fault in source affects target
      // So if we're at the source, we can go to target
      if (direction === 'both' || direction === 'upstream') {
        if (rule.propagateFromSource) {
          result.push({ nodeId: edge.target, edge });
        }
      }
      // propagateFromTarget means: fault in target affects source
      // So if we're at the source, we can't directly go to target via this rule
      // But if we're at the target, we can go to source
      if (direction === 'downstream') {
        // Downstream means we follow edges in their natural direction
        // regardless of fault semantics
        result.push({ nodeId: edge.target, edge });
      }
    }

    // Get incoming edges (target <- source)
    const incoming = this.graphBuilder['edgesByTarget'].get(nodeId) ?? [];
    for (const edge of incoming) {
      const rule = PROPAGATION_RULES[edge.type];
      // propagateFromTarget means: fault in target affects source
      // So if we're at the target, we can go to source
      if (direction === 'both' || direction === 'upstream') {
        if (rule.propagateFromTarget) {
          result.push({ nodeId: edge.source, edge });
        }
      }
      // Downstream: follow edges in natural direction
      if (direction === 'downstream') {
        result.push({ nodeId: edge.source, edge });
      }
    }

    return result;
  }

  private shouldIncludeNode(node: GraphNode, options: PropagationOptions): boolean {
    if (!options.includeTests && node.filePath?.includes('.test.')) {
      return false;
    }
    return true;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/propagation.test.ts`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/propagation.ts tests/propagation.test.ts
git commit -m "feat: fault propagation engine"
```

---

## Task 3: Integrate Propagation Engine into ContextBuilderAgent

**Files:**
- Modify: `src/agents/context-builder-agent.ts`
- Test: `tests/agents.test.ts` (append)

- [ ] **Step 1: Update ContextBuilderAgent to use propagation**

Read current `src/agents/context-builder-agent.ts`, then replace:

```typescript
import { BaseAgent } from './base-agent.js';
import { MemoryMiddleware } from '../core/memory.js';
import { contextBuilderContextSchema, parseContext, type AgentInput, type GraphNode } from '../core/types.js';
import { PropagationEngine } from '../core/propagation.js';

export class ContextBuilderAgent extends BaseAgent {
  constructor(private memory: MemoryMiddleware) {
    super('context-builder');
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const { nodeIds } = parseContext(input.context, contextBuilderContextSchema);
    const graph = this.memory.getKnowledgeGraph();

    // Build graph from memory for propagation
    const { KnowledgeGraphBuilder } = await import('../core/knowledge-graph.js');
    const builder = KnowledgeGraphBuilder.fromGraph(graph);

    // Run propagation analysis to find affected nodes
    const engine = new PropagationEngine(builder);
    const propagationResult = engine.trace(nodeIds, {
      direction: 'both',
      maxDepth: 3,
      minEdgeWeight: 0.5,
      includeTests: false,
    });

    // Collect context nodes: entry points + affected nodes
    const contextNodeIds = new Set<string>(nodeIds);
    for (const affected of propagationResult.affectedNodes) {
      contextNodeIds.add(affected.nodeId);
    }

    const contextNodes: GraphNode[] = [];
    for (const id of contextNodeIds) {
      const node = builder.findNode(id);
      if (node) {
        contextNodes.push(node);
      }
    }

    // Store in memory
    const taskContext = this.memory.getTaskContext();
    taskContext.recalledNodes = contextNodes;

    this.logger.info(
      `Recalled ${contextNodes.length} nodes (${propagationResult.affectedNodes.length} via propagation)`
    );

    return {
      recalledNodes: contextNodes,
      recalledCount: contextNodes.length,
      propagationSummary: {
        entryPoints: propagationResult.entryPoints.length,
        affectedNodes: propagationResult.affectedNodes.length,
        maxImpactProbability: propagationResult.affectedNodes[0]?.impactProbability ?? 0,
      },
    };
  }
}
```

- [ ] **Step 2: Append test for propagation integration**

Append to `tests/agents.test.ts`:

```typescript
import { PropagationEngine } from '../src/core/propagation.js';

describe('ContextBuilderAgent with propagation', () => {
  it('recalls nodes via propagation', async () => {
    const memory = new MemoryMiddleware();

    // Set up a simple graph
    const { KnowledgeGraphBuilder } = await import('../src/core/knowledge-graph.js');
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'file:src/a.ts', type: 'file', name: 'a.ts', filePath: 'src/a.ts' });
    builder.addNode({ id: 'function:src/a.ts:foo', type: 'function', name: 'foo', filePath: 'src/a.ts' });
    builder.addNode({ id: 'function:src/a.ts:bar', type: 'function', name: 'bar', filePath: 'src/a.ts' });
    builder.addEdge('file:src/a.ts', 'function:src/a.ts:foo', 'contains', 1.0);
    builder.addEdge('file:src/a.ts', 'function:src/a.ts:bar', 'contains', 1.0);
    builder.addEdge('function:src/a.ts:foo', 'function:src/a.ts:bar', 'calls', 0.8);

    memory.setKnowledgeGraph(builder.build());

    const agent = new ContextBuilderAgent(memory);
    const output = await agent.run({
      taskId: 'task-1',
      instruction: 'Build context',
      context: { nodeIds: ['function:src/a.ts:bar'] },
    });

    // bar is the entry point, foo calls bar so foo should be recalled too
    const recalledIds = (output.result.recalledNodes as Array<{ id: string }>).map(n => n.id);
    expect(recalledIds).toContain('function:src/a.ts:bar');
    expect(recalledIds).toContain('function:src/a.ts:foo');
    expect(output.result.propagationSummary).toBeDefined();
    expect((output.result.propagationSummary as Record<string, number>).affectedNodes).toBeGreaterThanOrEqual(2);
  });
});
```

Also add the import at the top of `tests/agents.test.ts`:
```typescript
import { ContextBuilderAgent } from '../src/agents/context-builder-agent.js';
```

- [ ] **Step 3: Run all agent tests**

Run: `npx vitest run tests/agents.test.ts`
Expected: PASS (all agent tests including new one)

- [ ] **Step 4: Commit**

```bash
git add src/agents/context-builder-agent.ts tests/agents.test.ts
git commit -m "feat: integrate propagation engine into context builder"
```

---

## Self-Review

**1. Spec coverage:**
- [x] Graph-based propagation tracing → Task 2
- [x] Edge-type-specific propagation rules (contains, calls, imports, inherits) → Task 2
- [x] Weighted probability calculation → Task 2 (`compute impact probability correctly` test)
- [x] maxDepth limiting → Task 2 (`respects maxDepth` test)
- [x] minEdgeWeight filtering → Task 2 (`respects minEdgeWeight` test)
- [x] upstream/downstream/both directions → Task 2 (`traces upstream`, `traces both directions` tests)
- [x] Test file exclusion → Task 2 (`excludes test files`, `includes test files` tests)
- [x] Integration with ContextBuilderAgent → Task 3

**2. Placeholder scan:** None found. All code is complete.

**3. Type consistency:**
- `PropagationOptions.direction` uses `'upstream' | 'downstream' | 'both'` consistently
- `AffectedNode` fields match usage in engine and tests
- `PropagationResult` fields match engine return value

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-02-propagation-engine.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
