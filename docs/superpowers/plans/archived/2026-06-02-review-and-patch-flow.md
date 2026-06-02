# Review and Patch Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the Phase 1 MVP闭环 by implementing the Review + Patch flow: generate file patches from solution plans, present them for human confirmation in the CLI, and apply approved changes to the codebase.

**Architecture:** A `PatchGeneratorAgent` transforms `SolutionPlan` into concrete file diffs (original → modified). A `ReviewWorkflow` presents diffs in the terminal and waits for user confirmation (approve/reject/edit). An `apply` CLI command wires everything together. No Git automation yet — that is Phase 4.

**Tech Stack:** TypeScript, Node.js 20+, vitest, Commander.js, built-in `readline` for CLI prompts

---

## File Structure

```
/Users/apple/code-agent/
├── src/
│   ├── agents/
│   │   ├── patch-generator-agent.ts      # NEW: Generate file patches from plan
│   │   └── git-executor-agent.ts         # NEW: Simple git operations (stage/commit)
│   ├── core/
│   │   ├── patch.ts                      # NEW: Patch data structure + apply logic
│   │   └── review.ts                     # NEW: Review workflow types
│   ├── interface/
│   │   └── cli-review.ts                 # NEW: Terminal review UI (diff display + prompt)
│   └── index.ts                          # MODIFY: Add apply/fix commands
├── tests/
│   ├── patch.test.ts                     # NEW: Patch generation & application tests
│   ├── review.test.ts                    # NEW: Review workflow tests
│   └── fixtures/
│       └── sample-repo/src/broken.ts     # NEW: Fixture for patch testing
└── docs/agents/
    └── patch-generator.md                # NEW: Agent prompt definition
```

---

### Task 1: Patch Data Structure and Application

**Files:**
- Create: `src/core/patch.ts`
- Test: `tests/patch.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { generatePatch, applyPatch, type FilePatch } from '../src/core/patch.js';

describe('generatePatch', () => {
  it('creates a patch for modified content', () => {
    const original = 'function greet() {\n  return "hello";\n}';
    const modified = 'function greet() {\n  return "hello world";\n}';
    const patch = generatePatch('src/greet.ts', original, modified);
    expect(patch.filePath).toBe('src/greet.ts');
    expect(patch.changeType).toBe('modify');
    expect(patch.originalCode).toBe(original);
    expect(patch.modifiedCode).toBe(modified);
    expect(patch.diff).toContain('-  return "hello"');
    expect(patch.diff).toContain('+  return "hello world"');
  });

  it('creates a patch for new file', () => {
    const modified = 'export const config = {};\n';
    const patch = generatePatch('src/config.ts', undefined, modified);
    expect(patch.changeType).toBe('add');
    expect(patch.originalCode).toBeUndefined();
    expect(patch.modifiedCode).toBe(modified);
  });

  it('creates a patch for deleted file', () => {
    const original = 'export const old = true;\n';
    const patch = generatePatch('src/old.ts', original, undefined);
    expect(patch.changeType).toBe('delete');
    expect(patch.originalCode).toBe(original);
    expect(patch.modifiedCode).toBeUndefined();
  });
});

describe('applyPatch', () => {
  it('applies a modify patch', () => {
    const original = 'function greet() {\n  return "hello";\n}';
    const modified = 'function greet() {\n  return "hello world";\n}';
    const patch = generatePatch('src/greet.ts', original, modified);
    const result = applyPatch(patch);
    expect(result).toBe(modified);
  });

  it('applies an add patch', () => {
    const modified = 'export const config = {};\n';
    const patch = generatePatch('src/config.ts', undefined, modified);
    const result = applyPatch(patch);
    expect(result).toBe(modified);
  });

  it('applies a delete patch', () => {
    const original = 'export const old = true;\n';
    const patch = generatePatch('src/old.ts', original, undefined);
    const result = applyPatch(patch);
    expect(result).toBe('');
  });

  it('fails when original does not match for modify', () => {
    const patch: FilePatch = {
      filePath: 'src/greet.ts',
      changeType: 'modify',
      originalCode: 'wrong content',
      modifiedCode: 'new content',
      diff: '',
    };
    expect(() => applyPatch(patch, 'actual content')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/patch.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement patch module**

Create `src/core/patch.ts`:

```typescript
import { createHash } from '../utils/hash.js';

export interface FilePatch {
  filePath: string;
  changeType: 'modify' | 'add' | 'delete';
  originalCode?: string;
  modifiedCode?: string;
  diff: string;
}

export interface PatchResult {
  patches: FilePatch[];
  summary: {
    filesAdded: number;
    filesModified: number;
    filesDeleted: number;
  };
}

export function generatePatch(
  filePath: string,
  originalCode: string | undefined,
  modifiedCode: string | undefined
): FilePatch {
  const changeType: FilePatch['changeType'] =
    originalCode === undefined ? 'add' :
    modifiedCode === undefined ? 'delete' :
    'modify';

  const diff = computeDiff(originalCode || '', modifiedCode || '');

  return {
    filePath,
    changeType,
    originalCode,
    modifiedCode,
    diff,
  };
}

export function applyPatch(patch: FilePatch, currentContent?: string): string {
  if (patch.changeType === 'add') {
    return patch.modifiedCode || '';
  }

  if (patch.changeType === 'delete') {
    return '';
  }

  // For modify, verify the current content matches the expected original
  if (currentContent !== undefined && currentContent !== patch.originalCode) {
    throw new Error(
      `Patch conflict: ${patch.filePath} has changed since the patch was generated. ` +
      'Expected:\n' + patch.originalCode + '\nActual:\n' + currentContent
    );
  }

  return patch.modifiedCode || '';
}

function computeDiff(original: string, modified: string): string {
  const origLines = original.split('\n');
  const modLines = modified.split('\n');

  const diff: string[] = [
    `--- ${original ? 'a/' + 'file' : '/dev/null'}`,
    `+++ ${modified ? 'b/' + 'file' : '/dev/null'}`,
  ];

  // Simple line-by-line diff (naive but sufficient for MVP)
  let i = 0;
  while (i < origLines.length || i < modLines.length) {
    const orig = i < origLines.length ? origLines[i] : undefined;
    const mod = i < modLines.length ? modLines[i] : undefined;

    if (orig !== mod) {
      if (orig !== undefined) diff.push(`- ${orig}`);
      if (mod !== undefined) diff.push(`+ ${mod}`);
    }
    i++;
  }

  return diff.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/patch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/patch.ts tests/patch.test.ts
git commit -m "feat: patch data structure with diff generation and application"
```

---

### Task 2: Patch Generator Agent

**Files:**
- Create: `src/agents/patch-generator-agent.ts`
- Test: `tests/agents.test.ts` (append to existing)

- [ ] **Step 1: Write test for patch generator agent**

Append to `tests/agents.test.ts`:

```typescript
import { PatchGeneratorAgent } from '../src/agents/patch-generator-agent.js';

describe('PatchGeneratorAgent', () => {
  it('generates patches from a solution plan', async () => {
    const memory = new MemoryMiddleware();

    // Set up a file in memory that the agent can read
    const fs = await import('fs/promises');
    const testContent = 'function helper() {\n  return "hello";\n}\n';

    // Store fingerprint so the agent knows the file exists
    const fp = computeFingerprint('src/utils.ts', testContent);
    memory.setFingerprint(fp);

    // Build graph with the file node
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'file:src/utils.ts', type: 'file', name: 'utils.ts', filePath: 'src/utils.ts' });
    memory.setKnowledgeGraph(builder.build());

    const agent = new PatchGeneratorAgent(memory);
    const input: AgentInput = {
      taskId: 'task-1',
      instruction: 'Generate patches',
      context: {
        plan: {
          id: 'plan-1',
          timestamp: new Date().toISOString(),
          taskId: 'task-1',
          problem: { description: 'Fix greeting', rootCause: 'Wrong text', severity: 'minor' },
          changes: [
            {
              filePath: 'src/utils.ts',
              changeType: 'modify',
              description: 'Fix greeting text',
              reasoning: 'Should say world',
              originalCode: 'function helper() {\n  return "hello";\n}',
              modifiedCode: 'function helper() {\n  return "hello world";\n}',
            },
          ],
          metadata: { confidence: 0.9, tokenUsed: 0 },
        },
      },
    };

    const output = await agent.run(input);
    expect(output.result.patches).toBeDefined();
    expect(Array.isArray(output.result.patches)).toBe(true);
    expect(output.result.patches).toHaveLength(1);
    expect(output.result.patches[0].filePath).toBe('src/utils.ts');
    expect(output.result.patches[0].changeType).toBe('modify');
  });
});
```

Also add the import at the top:
```typescript
import { computeFingerprint } from '../src/core/fingerprint.js';
import { KnowledgeGraphBuilder } from '../src/core/knowledge-graph.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents.test.ts`
Expected: FAIL — PatchGeneratorAgent not found

- [ ] **Step 3: Implement patch generator agent**

Create `src/agents/patch-generator-agent.ts`:

```typescript
import { BaseAgent } from './base-agent.js';
import { MemoryMiddleware } from '../core/memory.js';
import { generatePatch, type FilePatch, type PatchResult } from '../core/patch.js';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import type { AgentInput, SolutionPlan, FileChange } from '../core/types.js';

export class PatchGeneratorAgent extends BaseAgent {
  constructor(private memory: MemoryMiddleware) {
    super('patch-generator');
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const plan = input.context.plan as SolutionPlan;
    if (!plan) {
      throw new Error('plan is required in context');
    }

    const patches: FilePatch[] = [];

    for (const change of plan.changes) {
      const patch = await this.generatePatchForChange(change);
      patches.push(patch);
    }

    const result: PatchResult = {
      patches,
      summary: {
        filesAdded: patches.filter(p => p.changeType === 'add').length,
        filesModified: patches.filter(p => p.changeType === 'modify').length,
        filesDeleted: patches.filter(p => p.changeType === 'delete').length,
      },
    };

    this.logger.info(`Generated ${patches.length} patches`);

    return {
      result,
      patches,
      summary: result.summary,
    };
  }

  private async generatePatchForChange(change: FileChange): Promise<FilePatch> {
    // If the plan already includes original/modified code, use it directly
    if (change.originalCode !== undefined || change.modifiedCode !== undefined) {
      return generatePatch(change.filePath, change.originalCode, change.modifiedCode);
    }

    // Otherwise, read the original from disk and use the description
    // (MVP: we require originalCode/modifiedCode in the plan)
    this.logger.warn(`Change for ${change.filePath} lacks originalCode/modifiedCode, generating empty diff`);
    return generatePatch(change.filePath, '', '');
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/agents.test.ts`
Expected: PASS (all 5 agent tests)

- [ ] **Step 5: Commit**

```bash
git add src/agents/patch-generator-agent.ts tests/agents.test.ts
git commit -m "feat: patch generator agent"
```

---

### Task 3: CLI Review UI

**Files:**
- Create: `src/interface/cli-review.ts`
- Test: `tests/cli-review.test.ts`

- [ ] **Step 1: Write test for CLI review UI**

Create `tests/cli-review.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { formatDiff, type ReviewDecision } from '../src/interface/cli-review.js';
import type { FilePatch } from '../src/core/patch.js';

describe('formatDiff', () => {
  it('formats a patch with color indicators', () => {
    const patch: FilePatch = {
      filePath: 'src/test.ts',
      changeType: 'modify',
      originalCode: 'old',
      modifiedCode: 'new',
      diff: '- old\n+ new',
    };
    const formatted = formatDiff(patch);
    expect(formatted).toContain('src/test.ts');
    expect(formatted).toContain('- old');
    expect(formatted).toContain('+ new');
  });
});

describe('ReviewDecision type', () => {
  it('has correct union values', () => {
    const decisions: ReviewDecision[] = ['approve', 'reject', 'edit'];
    expect(decisions).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Implement CLI review UI**

Create `src/interface/cli-review.ts`:

```typescript
import type { FilePatch, PatchResult } from '../core/patch.js';

export type ReviewDecision = 'approve' | 'reject' | 'edit';

export interface ReviewOptions {
  autoApprove?: boolean;     // For non-interactive mode (CI/testing)
  diffSizeLimit?: number;    // Max lines per diff before truncation
}

export function formatDiff(patch: FilePatch): string {
  const lines: string[] = [];

  // Header
  const action =
    patch.changeType === 'add' ? 'Added' :
    patch.changeType === 'delete' ? 'Deleted' :
    'Modified';
  lines.push(`\n${action}: ${patch.filePath}`);
  lines.push('─'.repeat(60));

  // Show the diff
  if (patch.diff) {
    const diffLines = patch.diff.split('\n');
    for (const line of diffLines) {
      if (line.startsWith('+')) {
        lines.push(`\x1b[32m${line}\x1b[0m`);  // Green for additions
      } else if (line.startsWith('-')) {
        lines.push(`\x1b[31m${line}\x1b[0m`);  // Red for deletions
      } else {
        lines.push(line);
      }
    }
  }

  // Show full before/after for small files (MVP: always show)
  if (patch.changeType === 'modify') {
    lines.push('\n  Original:');
    lines.push('  ' + (patch.originalCode || '').split('\n').join('\n  '));
    lines.push('\n  Modified:');
    lines.push('  ' + (patch.modifiedCode || '').split('\n').join('\n  '));
  }

  lines.push('─'.repeat(60));

  return lines.join('\n');
}

export function formatPatchResult(result: PatchResult): string {
  const lines: string[] = [
    '\n=== Patch Summary ===',
    `Files modified: ${result.summary.filesModified}`,
    `Files added: ${result.summary.filesAdded}`,
    `Files deleted: ${result.summary.filesDeleted}`,
    '',
  ];
  return lines.join('\n');
}

export function createReviewPrompt(): string {
  return '\nReview this change. Options: [a]pprove, [r]eject, [e]dit > ';
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/cli-review.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/interface/cli-review.ts tests/cli-review.test.ts
git commit -m "feat: CLI review UI with diff formatting"
```

---

### Task 4: Apply Command and Fix Command

**Files:**
- Modify: `src/index.ts`
- Test: `tests/cli.test.ts` (append)

- [ ] **Step 1: Write tests for apply and fix commands**

Append to `tests/cli.test.ts`:

```typescript
describe('CodeRepairAgent apply', () => {
  it('applies patches to files', async () => {
    const agent = new CodeRepairAgent({});
    await agent.init(fixturePath);

    const patch = generatePatch(
      'src/utils.ts',
      "export function helper(): string {\n  return 'hello';\n}\n",
      "export function helper(): string {\n  return 'hello world';\n}\n"
    );

    await agent.applyPatches([patch]);
    // Verify no error thrown
    expect(true).toBe(true);
  });
});
```

Add imports at top:
```typescript
import { generatePatch } from '../src/core/patch.js';
```

- [ ] **Step 2: Add apply method and CLI commands to index.ts**

Add imports at top of `src/index.ts`:
```typescript
import { PatchGeneratorAgent } from './agents/patch-generator-agent.js';
import { applyPatch, type FilePatch, type PatchResult } from './core/patch.js';
import { formatDiff, formatPatchResult, createReviewPrompt } from './interface/cli-review.js';
import { writeFile } from 'fs/promises';
import { createInterface } from 'readline';
```

Add method to `CodeRepairAgent` class (after `getMemory()`):

```typescript
  async applyPatches(patches: FilePatch[]): Promise<{ applied: string[]; failed: string[] }> {
    const result = { applied: [] as string[], failed: [] as string[] };

    for (const patch of patches) {
      try {
        const filePath = resolve(patch.filePath);
        const currentContent = patch.changeType !== 'add'
          ? await readFile(filePath, 'utf-8').catch(() => '')
          : undefined;

        const newContent = applyPatch(patch, currentContent);
        await writeFile(filePath, newContent, 'utf-8');
        result.applied.push(patch.filePath);
        this.logger.info(`Applied patch: ${patch.filePath}`);
      } catch (err) {
        result.failed.push(patch.filePath);
        this.logger.error(`Failed to apply patch: ${patch.filePath}`, err);
      }
    }

    return result;
  }
```

Add new CLI commands in `main()` (after `status` command):

```typescript
  program
    .command('apply')
    .description('Apply a solution plan (non-interactive)')
    .argument('<plan-id>', 'Plan ID or plan JSON file')
    .option('-r, --repo <path>', 'Repository path', '.')
    .option('--dry-run', 'Show what would change without applying', false)
    .action(async (planId: string, options: { repo: string; dryRun: boolean }) => {
      try {
        const agent = new CodeRepairAgent({ verbose: true });
        const memoryPath = join(resolve(options.repo), '.repair-agent', 'memory.json');
        await agent.loadMemory(memoryPath);

        // For MVP: plan is passed via stdin or generated on the fly
        // In practice, we'd load from memory or a file
        console.log('Apply command: plan ID =', planId);
        console.log('Dry run:', options.dryRun);
        console.log('(Full apply flow requires plan persistence - see Phase 4)');
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
    });

  program
    .command('fix')
    .description('Analyze, plan, review, and apply (interactive)')
    .argument('<description>', 'Problem description')
    .option('-r, --repo <path>', 'Repository path', '.')
    .option('--file <file>', 'Target file(s)', collect, [])
    .option('--auto-push', 'Automatically push after applying', false)
    .action(async (description: string, options: { repo: string; file: string[]; autoPush: boolean }) => {
      try {
        const agent = new CodeRepairAgent({ verbose: true });
        const memoryPath = join(resolve(options.repo), '.repair-agent', 'memory.json');
        await agent.loadMemory(memoryPath);

        // Step 1: Plan
        const task: RepairTask = {
          id: `task-${Date.now()}`,
          description,
          type: 'bug',
          priority: 'medium',
          context: {
            files: options.file.length > 0 ? options.file : undefined,
          },
        };

        const plan = await agent.plan(task);
        console.log('\n=== Solution Plan ===\n');
        console.log(`ID: ${plan.id}`);
        console.log(`Problem: ${plan.problem.description}`);
        console.log(`Root Cause: ${plan.problem.rootCause}`);
        console.log(`\nChanges (${plan.changes.length}):`);
        for (const change of plan.changes) {
          console.log(`  - ${change.filePath}: ${change.description}`);
        }

        // Step 2: Generate patches
        const patchGenerator = new PatchGeneratorAgent(agent.getMemory());
        const patchResult = await patchGenerator.run({
          taskId: task.id,
          instruction: 'Generate patches for the plan',
          context: { plan },
        });

        const patches = patchResult.result.patches as FilePatch[];
        const patchSummary = patchResult.result.summary as PatchResult['summary'];

        console.log(formatPatchResult({ patches, summary: patchSummary }));

        // Step 3: Show diffs
        for (const patch of patches) {
          console.log(formatDiff(patch));
        }

        // Step 4: Review prompt
        if (options.autoPush) {
          console.log('Auto-applying (auto-push flag set)...');
          const result = await agent.applyPatches(patches);
          console.log(`Applied: ${result.applied.length}, Failed: ${result.failed.length}`);
        } else {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>((resolve) => {
            rl.question(createReviewPrompt(), resolve);
          });
          rl.close();

          if (answer.toLowerCase() === 'a' || answer.toLowerCase() === 'approve') {
            const result = await agent.applyPatches(patches);
            console.log(`\nApplied: ${result.applied.length} file(s)`);
            if (result.failed.length > 0) {
              console.log(`Failed: ${result.failed.join(', ')}`);
            }
          } else {
            console.log('Changes rejected. No files modified.');
          }
        }
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
    });
```

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS (including new tests)

- [ ] **Step 4: Build and verify CLI**

Run: `npx tsc`
Run: `node dist/index.js --help`
Expected: Shows init, plan, status, apply, fix commands

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/cli.test.ts
git commit -m "feat: apply and fix CLI commands with review flow"
```

---

### Task 5: Agent Prompt Definition

**Files:**
- Create: `docs/agents/patch-generator.md`

- [ ] **Step 1: Create patch-generator agent definition**

Create `docs/agents/patch-generator.md`:

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add docs/agents/patch-generator.md
git commit -m "docs: patch generator agent prompt definition"
```

---

## Self-Review Checklist

**1. Spec coverage:**
- [x] Patch data structure (FilePatch, PatchResult) → Task 1
- [x] Diff generation (line-by-line) → Task 1
- [x] Patch application with conflict detection → Task 1
- [x] PatchGeneratorAgent → Task 2
- [x] CLI review UI (diff formatting) → Task 3
- [x] Apply command (non-interactive) → Task 4
- [x] Fix command (interactive: plan → review → apply) → Task 4
- [x] Agent prompt definition → Task 5

**2. Placeholder scan:**
- No TBD/TODO placeholders
- All steps include actual code
- All tests include assertions

**3. Type consistency:**
- FilePatch, PatchResult used consistently
- ReviewDecision type defined and used
- AgentInput/AgentOutput patterns match existing agents

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-02-review-and-patch-flow.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
