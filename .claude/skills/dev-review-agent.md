---
name: dev-review-agent
description: |
  Development Review Agent for the Code Repair Agent project.
  Use this skill when you need to: review code changes, assess project progress,
  restore project context after a session break, or evaluate architecture decisions.
  This skill loads the full project context (design docs, progress, findings)
  and provides structured review capabilities.
triggers:
  - "review"
  - "dev review"
  - "code review"
  - "progress check"
  - "where are we"
  - "what's next"
  - "context"
  - "architecture review"
  - "评估进度"
  - "审查代码"
  - "恢复上下文"
  - "review my changes"
  - "check progress"
  - "continue from before"
  - "what was I doing"
  - "resume work"
  - "review this"
  - "architecture check"
  - "design review"
version: 1.0.0
---

# Dev Review Agent

## Context Restoration Protocol

When this skill is invoked, **ALWAYS** perform context restoration first before any review or analysis. This ensures you have the full picture of where the project stands.

### Step 1: Load Project Context Files

Read these files in order (they build upon each other):

1. **`/Users/apple/code-agent/CONTEXT.md`** — Project background, requirements, key decisions
2. **`/Users/apple/code-agent/DESIGN.md`** — System architecture, module design, data flows
3. **`/Users/apple/code-agent/PROGRESS.md`** — Current implementation status, completed tasks, known limitations
4. **`/Users/apple/code-agent/KEY-FINDINGS.md`** — Analysis of reference project (Understand-Anything), design patterns to follow

### Step 2: Assess Current Code State

Run these commands to understand what changed since the design was written:

```bash
# Check git status for uncommitted changes
git status --short

# Check recent commits to understand recent work
git log --oneline -10

# Check current branch
git branch --show-current

# Check for any diff since last review point
git diff HEAD~1 --stat
```

### Step 3: Verify Build & Test Health

```bash
# Verify TypeScript compiles
npx tsc --noEmit

# Run full test suite
npx vitest run
```

### Step 4: Scan File Structure

```bash
# List all source files with line counts
find src -name '*.ts' -exec wc -l {} + | sort -n
```

## Review Modes

Based on user's intent, enter one of these review modes:

### Mode A: Progress Assessment
**Trigger**: User asks about progress, what's done, what's next, "where are we"

**Output**:
1. Current Phase completion percentage (from PROGRESS.md)
2. List of completed features with file references
3. List of pending features prioritized by roadmap
4. Any blockers or technical debt that needs attention
5. Recommended next 3 tasks

### Mode B: Code Review
**Trigger**: User asks to review changes, "review this", "check my code"

**Checklist** (verify each item):
- [ ] **Type Safety**: No `any` types, no unsafe casts without guards
- [ ] **Error Handling**: Errors are caught and reported, not silently swallowed
- [ ] **Defensive Copying**: Getters return copies, not direct references
- [ ] **Test Coverage**: New code has corresponding tests
- [ ] **Naming**: Functions/variables clearly describe their purpose
- [ ] **Single Responsibility**: Each function/module does one thing
- [ ] **No Dead Code**: No unused imports, variables, or functions
- [ ] **Consistent Patterns**: Follows existing project conventions
- [ ] **Documentation**: Public APIs have clear interfaces
- [ ] **Performance**: No obvious N+1 or O(n²) issues without justification

**Output**:
1. Summary of changes reviewed
2. Issues found (Critical / Important / Minor)
3. Strengths of the implementation
4. Actionable fixes with file:line references

### Mode C: Architecture Review
**Trigger**: User asks about architecture, design decisions, "does this fit"

**Check against DESIGN.md**:
1. Does the implementation match the architectural layers?
2. Are Agent responsibilities correctly separated?
3. Does the data flow match the design?
4. Is the memory layer correctly implemented per spec?
5. Does the knowledge graph model match the design?

**Output**:
1. Architecture alignment assessment
2. Deviations from design (if any) with justification
3. Recommendations for structural improvements

### Mode D: Context Recovery
**Trigger**: User says "continue", "resume", "what was I doing", "catch me up"

**Output**:
1. Brief summary of project purpose and current phase
2. What was being worked on (from git log and PROGRESS.md)
3. Current open questions or decisions pending
4. Suggested next action

## Review Report Template

Always structure your review report as follows:

```
## Review Summary
[One-line verdict: Ready to proceed / Needs fixes / Blocked]

## Context Restored
- Project: [name]
- Phase: [current phase from PROGRESS.md]
- Branch: [git branch]
- Last work: [from git log]
- Build status: [pass/fail]
- Tests: [X/Y passing]

## Findings

### Critical (must fix)
1. [issue with file:line]

### Important (should fix)
1. [issue with file:line]

### Minor (nice to have)
1. [issue with file:line]

## Strengths
1. [what's done well]

## Next Steps
1. [recommended action]
2. [recommended action]
3. [recommended action]
```

## Project-Specific Knowledge

This project is the **Code Repair Agent** — an AI-powered code repair system based on Understand-Anything's multi-agent architecture.

### Key Architectural Principles
1. **Multi-Agent Pipeline**: Scanner → Detector → Context Builder → Planner → (future: Patch Generator → Git Executor)
2. **Three-Layer Memory**: L1 (Repo static), L2 (Task dynamic), L3 (Learned cross-task)
3. **Fingerprint-Based Incremental Analysis**: SHA-256 + structural signatures for change classification
4. **Knowledge Graph**: File/function/class nodes with 31 edge types
5. **Tree-sitter + LLM Hybrid**: Deterministic parsing (Tree-sitter) + semantic analysis (LLM)

### Current Implementation Status (as of PROGRESS.md)
- **Phase 1 (MVP)**: ~80% complete
- **Phase 2 (Memory Optimization)**: ~30% complete
- **Phases 3-5**: Not started

### Tech Stack
- TypeScript 5.4+, Node.js 20+, ESM
- vitest for testing
- Commander.js for CLI
- Tree-sitter (dependency added, integration pending Phase 2)
- fuse.js (dependency added, usage pending)

### Known Limitations
- Regex-based code parsing (MVP shortcut, replace with Tree-sitter in Phase 2)
- FaultDetector is heuristic-only (no LLM yet)
- SolutionPlanner generates generic plans (no LLM yet)
- No web search, patch generation, or git execution yet

## Rules

1. **Always restore context first** — Never skip the context loading steps
2. **Be specific** — Reference file:line for every issue found
3. **Balance critique** — Always mention strengths alongside issues
4. **Prioritize** — Distinguish critical vs important vs minor clearly
5. **Actionable** — Every issue should have a clear fix recommendation
6. **No guesswork** — If unsure about something, say so and suggest verification
7. **Respect MVP scope** — Don't flag Phase 2+ limitations as blockers for Phase 1
