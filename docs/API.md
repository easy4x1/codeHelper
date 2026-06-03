# API Reference

> CLI commands and programmatic interfaces

---

## CLI Commands

### `code-agent init [repo-path]`

Scan a repository and initialize the knowledge graph.

```bash
code-agent init ./my-project
```

**Output**:
```
Scanned 47 files, 47 fingerprints
Nodes: 124
Edges: 89
Memory saved to ./my-project/.repair-agent/memory.json
```

---

### `code-agent plan <description>`

Generate a repair plan without applying changes.

```bash
code-agent plan "Fix null pointer in auth module" \
  --provider anthropic \
  --model claude-sonnet-4-6 \
  --budget 100000 \
  --file src/auth.ts
```

**Options**:

| Option | Default | Description |
|--------|---------|-------------|
| `-r, --repo <path>` | `.` | Repository path |
| `--file <file>` | `[]` | Target file(s), repeatable |
| `--provider <name>` | `template` | LLM provider |
| `--model <name>` | provider default | Model name |
| `--budget <tokens>` | `50000` | Total token budget |
| `--web-search` | `true` | Enable web search (auto-triggered when local confidence < 0.5) |
| `--no-web-search` | `false` | Disable web search for local-only analysis |

**Output**:
```
=== Solution Plan ===

ID: plan-abc123
Problem: Fix null pointer in auth module
Root Cause: Missing null check before accessing user.email

Changes (2):
  - src/auth.ts: Add null check before accessing user.email
  - src/auth.test.ts: Add test case for null user

Confidence: 87.5%
```

---

### `code-agent fix <description>`

Full interactive repair flow: plan → patch → review → apply.

```bash
code-agent fix "Fix memory leak in user service" \
  --provider moonshot \
  --model kimi-k2.5 \
  --budget 80000
```

**Interactive Review**:
```
=== Patch Summary ===
Files modified: 1
Files added: 0
Files deleted: 0

Modified: src/user-service.ts
────────────────────────────────────────────────────────
-   return user.data;
+   return user?.data ?? null;
────────────────────────────────────────────────────────

Review this change. Options: [a]pprove, [r]eject, [e]dit > a

Applied: 1 file(s)
```

**Options**: Same as `plan`, plus:

| Option | Default | Description |
|--------|---------|-------------|
| `--auto-push` | `false` | Apply without confirmation |

---

### `code-agent apply <plan-id>`

Apply an already-reviewed plan non-interactively.

```bash
code-agent apply plan-abc123 --repo ./my-project --dry-run
```

| Option | Default | Description |
|--------|---------|-------------|
| `--dry-run` | `false` | Show changes without applying |

---

### `code-agent sync [repo-path]`

Incremental sync: detect file changes and update knowledge graph.

```bash
code-agent sync ./my-project
```

**Output**:
```
=== Sync Complete ===
Files analyzed: 47
  Unchanged:  43
  Cosmetic:   2
  Structural: 1
  Added:      1
  Deleted:    0
```

| Option | Default | Description |
|--------|---------|-------------|
| `--force-full` | `false` | Force full re-analysis |

---

### `code-agent status [repo-path]`

Show knowledge graph statistics.

```bash
code-agent status ./my-project
```

**Output**:
```
Nodes: 124
Edges: 89
Fingerprints: 47
```

### `code-agent batch <tasks.json>`

Batch process multiple repair tasks from a JSON file.

```bash
code-agent batch tasks.json --parallel --auto-push
```

**Input format (`tasks.json`)**:
```json
[
  {
    "id": "task-1",
    "description": "Fix null pointer in auth",
    "type": "bug",
    "priority": "high"
  },
  {
    "id": "task-2",
    "description": "Refactor user service",
    "type": "refactor",
    "priority": "medium"
  }
]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--parallel` | `false` | Run tasks in parallel instead of sequential |
| `--auto-push` | `false` | Auto-push after each task completion |

---

### `code-agent history`

View task history, extracted fault/fix patterns, and learned project conventions.

```bash
code-agent history
```

**Output**:
```
=== Task History (12 tasks) ===
  task-1: Fix null pointer — 2026-06-01 — approved
  task-2: Refactor auth — 2026-06-02 — approved

=== Fault Patterns (3) ===
  null-deref: 5 occurrences
  memory-leak: 2 occurrences

=== Project Conventions ===
  Naming: camelCase (functions), PascalCase (classes)
  Testing: *.test.ts, describe/it pattern
```

---

### `code-agent learn`

Learn project conventions from the current codebase and persist to L3 memory.

```bash
code-agent learn ./my-project
```

---

### `code-agent metrics`

Show performance metrics and statistics.

```bash
code-agent metrics
# JSON output
code-agent metrics --json
# Reset counters
code-agent metrics --reset
```

**Output**:
```
=== Metrics ===
Agent Performance:
  repo-scanner:  45ms avg (12 calls)
  fault-detector: 120ms avg (8 calls)
Token Usage:
  Total: 45,230 tokens
  Analysis: 18,000 (40%)
  Planning: 13,500 (30%)
Cache Hit Rates:
  ResultCache: 67% (12 hit / 18 miss)
  SemanticCache: 45% (5 hit / 11 miss)
Parser Coverage:
  tree-sitter: 6 languages
  regex-fallback: 16 languages
```

---

## Programmatic API

### `CodeRepairAgent`

```typescript
import { CodeRepairAgent } from 'code-repair-agent';

const agent = new CodeRepairAgent({
  verbose: true,
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  tokenBudget: {
    total: 100000,
    analysis: 40000,
    planning: 30000,
    search: 20000,
    review: 10000,
  },
});

// Initialize repository
await agent.init('./my-project');

// Generate plan
const plan = await agent.plan({
  id: 'task-1',
  description: 'Fix null pointer in auth module',
  type: 'bug',
  priority: 'high',
  context: {
    files: ['src/auth.ts'],
  },
});

// Check token budget status
const budget = agent.getBudgetManager().getStatus();
console.log(`${budget.remaining}/${budget.total} tokens remaining`);
```

### `AgentConfig`

```typescript
interface AgentConfig {
  verbose?: boolean;
  memoryPath?: string;
  provider?: string;      // 'anthropic' | 'openai' | 'moonshot' | 'deepseek' | 'zhipu' | 'template'
  model?: string;         // e.g. 'claude-sonnet-4-6', 'kimi-k2.5', 'glm-5.1'
  tokenBudget?: {
    total?: number;
    analysis?: number;
    search?: number;
    planning?: number;
    review?: number;
  };
}
```

### `RepairTask`

```typescript
interface RepairTask {
  id: string;
  description: string;
  type: 'bug' | 'feature' | 'refactor' | 'performance' | 'security';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  context?: {
    files?: string[];
    errorLog?: string;
    stackTrace?: string;
  };
  constraints?: {
    maxFiles?: number;
    breakingChanges?: boolean;
    testRequired?: boolean;
  };
}
```

---

## Environment Variables

| Variable | Provider | Required For |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic | Claude models |
| `ANTHROPIC_BASE_URL` | Anthropic | Custom endpoint (e.g. Kimi compatible) |
| `ANTHROPIC_MODEL` | Anthropic | Default model override |
| `OPENAI_API_KEY` | OpenAI | GPT models |
| `MOONSHOT_API_KEY` | Moonshot | Kimi models |
| `DEEPSEEK_API_KEY` | DeepSeek | DeepSeek models |
| `ZHIPU_API_KEY` | Zhipu | GLM models |

All keys are automatically masked in logs:
```
key: sk-a****YhbK
```

---

## Token Budget API

```typescript
const budget = agent.getBudgetManager();

// Record usage
budget.recordUsage('analysis', 1500);

// Check status
const status = budget.getStatus();
// { total: 100000, used: 1500, remaining: 98500, usageByCategory: {...} }

// Check degradation
const rec = budget.checkDegradation();
// { level: 'none', shouldProceed: true, adjustments: {...}, message: '...' }

// Estimate tokens for text
const tokens = budget.estimateTokens(sourceCode);
```
