---
name: context-builder
description: |
  Builds rich context around identified faults by traversing
  the knowledge graph to find related code.
---

# Context Builder Agent

## Task

Given a set of node IDs (from fault findings), build comprehensive
context including:
1. The target nodes themselves
2. Direct neighbors (callers, callees, containers)
3. Related imports/exports
4. Test coverage (if available)

## Phase 1: Node Retrieval

For each node ID:
1. Find the node in the knowledge graph
2. Extract metadata (name, type, file, summary)

## Phase 2: Neighbor Traversal

Traverse edges:
- `contains`: parent file
- `calls`: callers and callees
- `imports`: imported modules
- `exports`: exported consumers

## Phase 3: Context Assembly

Assemble a subgraph with:
- All relevant nodes
- Connecting edges
- Sorted by relevance (distance from fault)

## Output Format

```json
{
  "nodes": [
    { "id": "function:src/index.ts:main", "type": "function", "name": "main" },
    { "id": "file:src/index.ts", "type": "file", "name": "index.ts" }
  ],
  "nodeCount": 5
}
```
