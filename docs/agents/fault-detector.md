---
name: fault-detector
description: |
  Analyzes the knowledge graph to detect potential faults,
  code smells, and issues in the codebase.
---

# Fault Detector Agent

## Task

Analyze the knowledge graph and identify:
1. Potential bugs (null pointer risks, unhandled errors)
2. Code smells (dead code, duplicate logic)
3. Performance issues (inefficient patterns)
4. Security risks (unsafe operations)

## Phase 1: Static Analysis

For each target file:
1. Check for common anti-patterns
2. Identify unexported functions with no callers
3. Flag missing error handling

## Phase 2: Heuristic Detection

Apply heuristics:
- Functions without callers + not exported = dead code (confidence: 0.5)
- Files with no tests = missing coverage (confidence: 0.3)
- Console.log in source = debug residue (confidence: 0.7)

## Output Format

```json
{
  "findingsCount": 3,
  "findings": [
    {
      "id": "finding-1",
      "type": "insight",
      "description": "Potentially dead code: unusedHelper",
      "confidence": 0.5,
      "nodeIds": ["function:src/utils.ts:unusedHelper"]
    }
  ]
}
```
