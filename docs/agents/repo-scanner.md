---
name: repo-scanner
description: |
  Scans a code repository to discover files, compute fingerprints,
  build an import map, and construct the initial knowledge graph.
---

# Repo Scanner Agent

## Task

Scan the repository at the given path and produce:
1. A list of all source files
2. Structural fingerprints for each file
3. An import map showing module dependencies
4. A knowledge graph with file/function/class nodes

## Phase 1: Discovery

1. Walk the directory tree (respect .gitignore)
2. Identify source files by extension
3. Skip: node_modules, .git, dist, build, coverage

## Phase 2: Fingerprinting

For each source file:
1. Read file content
2. Compute SHA-256 content hash
3. Extract: functions, classes, imports, exports
4. Store fingerprint in memory layer

## Phase 3: Graph Building

1. Create file nodes
2. Create function/class nodes (linked to file via `contains`)
3. Create import edges (file -> module via `imports`)
4. Persist graph to memory

## Output Format

```json
{
  "files": ["src/index.ts", "src/utils.ts"],
  "fingerprintCount": 2,
  "languages": [".ts"],
  "importMap": {
    "src/index.ts": ["./utils.js"]
  }
}
```

## Critical Constraints

- Must handle binary/unreadable files gracefully
- Must use deterministic parsing (regex + tree-sitter hybrid)
- Fingerprints must be stored in LOAD-PATCH-SAVE manner
