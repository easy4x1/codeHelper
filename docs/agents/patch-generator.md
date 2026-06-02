---
name: patch-generator
description: |
  Transforms a solution plan into concrete file patches (diffs)
  that can be reviewed and applied to the codebase.
---

# Patch Generator Agent

## Task

Given a SolutionPlan, produce:
1. A FilePatch for each change in the plan
2. A unified diff showing original → modified
3. A summary of files affected

## Phase 1: Change Validation

For each FileChange in the plan:
1. Verify the file exists (for modify/delete)
2. Read current file content from disk
3. Validate that originalCode matches current content

## Phase 2: Patch Generation

1. Generate diff using line-by-line comparison
2. Color-code additions (+) and deletions (-)
3. Handle add/modify/delete change types

## Phase 3: Safety Checks

1. Verify no overlapping changes to same file
2. Check file size limits
3. Flag potential conflicts

## Output Format

```json
{
  "patches": [
    {
      "filePath": "src/utils.ts",
      "changeType": "modify",
      "originalCode": "function greet() {\n  return 'hello';\n}",
      "modifiedCode": "function greet() {\n  return 'hello world';\n}",
      "diff": "..."
    }
  ],
  "summary": {
    "filesAdded": 0,
    "filesModified": 1,
    "filesDeleted": 0
  }
}
```

## Critical Constraints

- Must verify originalCode matches current file before generating patch
- Must handle binary files gracefully (skip with warning)
- Must produce deterministic diffs (same input → same output)
