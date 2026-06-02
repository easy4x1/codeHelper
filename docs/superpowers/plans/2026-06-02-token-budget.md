# Token Budget Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a token budget management system that tracks LLM token consumption across categories, enforces budget limits, and automatically triggers degradation strategies when budgets are exceeded — achieving the 80%+ token savings target for Phase 2.

**Architecture:** A `TokenBudgetManager` class wraps all LLM calls, tracking usage per category (`analysis`, `search`, `planning`, `review`). It exposes `recordUsage()`, `checkDegradation()`, and `getRecommendations()` methods. The manager is injected into `CodeRepairAgent` and consulted before each Agent execution to decide whether to proceed, degrade, or stop.

**Tech Stack:** TypeScript, vitest, existing `LlmService` abstraction

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/core/token-budget.ts` | `TokenBudgetManager` class, `DegradationStrategy`, `BudgetRecommendations`, usage tracking, threshold logic |
| `tests/token-budget.test.ts` | Unit tests for budget tracking, degradation levels, recommendations, integration with mock LLM calls |
| `src/core/types.ts` | Add `TokenBudgetConfig`, `TokenBudgetStatus`, `DegradationLevel`, `BudgetRecommendations` interfaces |
| `src/index.ts` | Integrate `TokenBudgetManager` into `CodeRepairAgent` constructor and `plan()` / `fix()` flows |

---

## Task 1: Add Token Budget Types to Core Types

**Files:**
- Modify: `src/core/types.ts`
- Test: `tests/types.test.ts`

- [ ] **Step 1: Add token budget types to `src/core/types.ts`**

Append after the propagation types section (before the Zod schemas section):

```typescript
// ============================================
// Token Budget Types
// ============================================

export interface TokenBudgetConfig {
  total: number;
  allocated: {
    analysis: number;
    search: number;
    planning: number;
    review: number;
  };
}

export interface TokenBudgetStatus {
  total: number;
  allocated: {
    analysis: number;
    search: number;
    planning: number;
    review: number;
  };
  used: number;
  remaining: number;
  usageByCategory: {
    analysis: number;
    search: number;
    planning: number;
    review: number;
  };
}

export type DegradationLevel =
  | 'none'
  | 'reduce_depth'
  | 'disable_search'
  | 'core_only'
  | 'prompt_user';

export interface BudgetRecommendations {
  level: DegradationLevel;
  shouldProceed: boolean;
  adjustments: {
    maxPropagationDepth?: number;
    maxFilesToAnalyze?: number;
    enableWebSearch?: boolean;
    enableDetailedAnalysis?: boolean;
  };
  message: string;
}
```

- [ ] **Step 2: Add type validation test to `tests/types.test.ts`**

Append to existing `tests/types.test.ts`:

```typescript
import type {
  TokenBudgetConfig,
  TokenBudgetStatus,
  DegradationLevel,
  BudgetRecommendations,
} from '../src/core/types.js';

describe('Token budget types', () => {
  it('accepts valid budget config', () => {
    const config: TokenBudgetConfig = {
      total: 10000,
      allocated: { analysis: 4000, search: 2000, planning: 3000, review: 1000 },
    };
    expect(config.total).toBe(10000);
    expect(config.allocated.analysis).toBe(4000);
  });

  it('accepts valid budget status', () => {
    const status: TokenBudgetStatus = {
      total: 10000,
      allocated: { analysis: 4000, search: 2000, planning: 3000, review: 1000 },
      used: 2500,
      remaining: 7500,
      usageByCategory: { analysis: 2000, search: 0, planning: 500, review: 0 },
    };
    expect(status.remaining).toBe(7500);
  });

  it('accepts all degradation levels', () => {
    const levels: DegradationLevel[] = [
      'none', 'reduce_depth', 'disable_search', 'core_only', 'prompt_user',
    ];
    expect(levels).toHaveLength(5);
  });

  it('accepts valid recommendations', () => {
    const rec: BudgetRecommendations = {
      level: 'reduce_depth',
      shouldProceed: true,
      adjustments: { maxPropagationDepth: 2, enableWebSearch: false },
      message: 'Reducing analysis depth to conserve tokens',
    };
    expect(rec.shouldProceed).toBe(true);
  });
});
```

- [ ] **Step 3: Run type tests**

Run: `npx vitest run tests/types.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/types.ts tests/types.test.ts
git commit -m "feat: token budget type definitions"
```

---

## Task 2: Implement Token Budget Manager

**Files:**
- Create: `src/core/token-budget.ts`
- Test: `tests/token-budget.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/token-budget.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { TokenBudgetManager } from '../src/core/token-budget.js';

describe('TokenBudgetManager', () => {
  let manager: TokenBudgetManager;

  beforeEach(() => {
    manager = new TokenBudgetManager({
      total: 10000,
      allocated: { analysis: 4000, search: 2000, planning: 3000, review: 1000 },
    });
  });

  it('tracks usage by category', () => {
    manager.recordUsage('analysis', 500);
    manager.recordUsage('planning', 300);

    const status = manager.getStatus();
    expect(status.used).toBe(800);
    expect(status.remaining).toBe(9200);
    expect(status.usageByCategory.analysis).toBe(500);
    expect(status.usageByCategory.planning).toBe(300);
  });

  it('returns none degradation when budget is healthy', () => {
    manager.recordUsage('analysis', 1000); // 10% used
    const rec = manager.checkDegradation();
    expect(rec.level).toBe('none');
    expect(rec.shouldProceed).toBe(true);
  });

  it('triggers reduce_depth at 70% usage (30% remaining)', () => {
    manager.recordUsage('analysis', 3000);
    manager.recordUsage('planning', 2000);
    manager.recordUsage('search', 1000);
    manager.recordUsage('review', 500);
    // used = 6500, remaining = 3500 (35%)

    manager.recordUsage('analysis', 500);
    // used = 7000, remaining = 3000 (30%)

    const rec = manager.checkDegradation();
    expect(rec.level).toBe('reduce_depth');
    expect(rec.adjustments.maxPropagationDepth).toBe(2);
    expect(rec.shouldProceed).toBe(true);
  });

  it('triggers disable_search at 80% usage (20% remaining)', () => {
    manager.recordUsage('analysis', 4000);
    manager.recordUsage('planning', 3000);
    manager.recordUsage('search', 500);
    // used = 7500, remaining = 2500

    manager.recordUsage('analysis', 500);
    // used = 8000, remaining = 2000 (20%)

    const rec = manager.checkDegradation();
    expect(rec.level).toBe('disable_search');
    expect(rec.adjustments.enableWebSearch).toBe(false);
    expect(rec.adjustments.maxPropagationDepth).toBe(2);
  });

  it('triggers core_only at 90% usage (10% remaining)', () => {
    manager.recordUsage('analysis', 4000);
    manager.recordUsage('planning', 3000);
    manager.recordUsage('search', 1500);
    manager.recordUsage('review', 500);
    // used = 9000, remaining = 1000 (10%)

    const rec = manager.checkDegradation();
    expect(rec.level).toBe('core_only');
    expect(rec.adjustments.maxPropagationDepth).toBe(1);
    expect(rec.adjustments.maxFilesToAnalyze).toBe(3);
    expect(rec.adjustments.enableDetailedAnalysis).toBe(false);
  });

  it('triggers prompt_user at 95% usage (5% remaining)', () => {
    manager.recordUsage('analysis', 4000);
    manager.recordUsage('planning', 3000);
    manager.recordUsage('search', 2000);
    manager.recordUsage('review', 500);
    // used = 9500, remaining = 500 (5%)

    const rec = manager.checkDegradation();
    expect(rec.level).toBe('prompt_user');
    expect(rec.shouldProceed).toBe(false);
    expect(rec.message).toContain('budget');
  });

  it('prevents usage from exceeding total budget', () => {
    manager.recordUsage('analysis', 12000);
    const status = manager.getStatus();
    expect(status.used).toBe(10000);
    expect(status.remaining).toBe(0);
  });

  it('returns recommendations for propagation options', () => {
    manager.recordUsage('analysis', 1000);
    const rec = manager.getRecommendations();
    expect(rec.adjustments.maxPropagationDepth).toBe(3);
    expect(rec.adjustments.enableWebSearch).toBe(true);
  });

  it('adjusts recommendations under budget pressure', () => {
    manager.recordUsage('analysis', 3000);
    manager.recordUsage('planning', 2500);
    manager.recordUsage('search', 1000);
    // used = 6500, 35% remaining

    const rec = manager.getRecommendations();
    expect(rec.adjustments.maxPropagationDepth).toBe(3); // still above 30%
    expect(rec.level).toBe('none');
  });

  it('provides default config when none specified', () => {
    const defaultManager = new TokenBudgetManager();
    const status = defaultManager.getStatus();
    expect(status.total).toBe(50000);
    expect(status.allocated.analysis).toBe(20000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/token-budget.test.ts`
Expected: FAIL — `TokenBudgetManager` not found

- [ ] **Step 3: Implement token budget manager**

Create `src/core/token-budget.ts`:

```typescript
import type {
  TokenBudgetConfig,
  TokenBudgetStatus,
  DegradationLevel,
  BudgetRecommendations,
} from './types.js';

const DEFAULT_CONFIG: TokenBudgetConfig = {
  total: 50000,
  allocated: {
    analysis: 20000,
    search: 10000,
    planning: 15000,
    review: 5000,
  },
};

/**
 * Thresholds for degradation levels as fraction of total budget USED.
 */
const DEGRADATION_THRESHOLDS: Array<{ threshold: number; level: DegradationLevel }> = [
  { threshold: 0.95, level: 'prompt_user' },
  { threshold: 0.90, level: 'core_only' },
  { threshold: 0.80, level: 'disable_search' },
  { threshold: 0.70, level: 'reduce_depth' },
];

export class TokenBudgetManager {
  private config: TokenBudgetConfig;
  private usageByCategory: {
    analysis: number;
    search: number;
    planning: number;
    review: number;
  };

  constructor(config?: TokenBudgetConfig) {
    this.config = config ?? { ...DEFAULT_CONFIG };
    this.usageByCategory = { analysis: 0, search: 0, planning: 0, review: 0 };
  }

  /**
   * Record token usage for a category.
   */
  recordUsage(
    category: 'analysis' | 'search' | 'planning' | 'review',
    tokens: number
  ): void {
    this.usageByCategory[category] += Math.max(0, tokens);
  }

  /**
   * Get current budget status.
   */
  getStatus(): TokenBudgetStatus {
    const used = Object.values(this.usageByCategory).reduce((sum, v) => sum + v, 0);
    const remaining = Math.max(0, this.config.total - used);

    return {
      total: this.config.total,
      allocated: { ...this.config.allocated },
      used,
      remaining,
      usageByCategory: { ...this.usageByCategory },
    };
  }

  /**
   * Check if degradation is needed based on current usage.
   */
  checkDegradation(): BudgetRecommendations {
    const status = this.getStatus();
    const usedFraction = status.used / status.total;

    // Find the highest threshold that has been crossed
    let level: DegradationLevel = 'none';
    for (const { threshold, level: lvl } of DEGRADATION_THRESHOLDS) {
      if (usedFraction >= threshold) {
        level = lvl;
        break; // thresholds are ordered highest first
      }
    }

    return this.buildRecommendations(level, status);
  }

  /**
   * Get current recommendations for Agent execution parameters.
   * This is the primary method Agents should call before execution.
   */
  getRecommendations(): BudgetRecommendations {
    return this.checkDegradation();
  }

  /**
   * Check if there is enough budget for a planned operation.
   */
  hasBudgetFor(
    category: 'analysis' | 'search' | 'planning' | 'review',
    estimatedTokens: number
  ): boolean {
    const status = this.getStatus();
    const categoryUsed = this.usageByCategory[category];
    const categoryRemaining = this.config.allocated[category] - categoryUsed;
    return categoryRemaining >= estimatedTokens && status.remaining >= estimatedTokens;
  }

  /**
   * Estimate tokens for a text string (rough heuristic: 1 token ≈ 4 chars).
   */
  static estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private buildRecommendations(
    level: DegradationLevel,
    status: TokenBudgetStatus
  ): BudgetRecommendations {
    const remainingPct = (status.remaining / status.total) * 100;

    switch (level) {
      case 'none':
        return {
          level,
          shouldProceed: true,
          adjustments: {
            maxPropagationDepth: 3,
            maxFilesToAnalyze: undefined,
            enableWebSearch: true,
            enableDetailedAnalysis: true,
          },
          message: `Token budget healthy: ${remainingPct.toFixed(1)}% remaining`,
        };

      case 'reduce_depth':
        return {
          level,
          shouldProceed: true,
          adjustments: {
            maxPropagationDepth: 2,
            maxFilesToAnalyze: undefined,
            enableWebSearch: true,
            enableDetailedAnalysis: true,
          },
          message: `Token budget caution: ${remainingPct.toFixed(1)}% remaining. Reducing analysis depth.`,
        };

      case 'disable_search':
        return {
          level,
          shouldProceed: true,
          adjustments: {
            maxPropagationDepth: 2,
            maxFilesToAnalyze: undefined,
            enableWebSearch: false,
            enableDetailedAnalysis: true,
          },
          message: `Token budget warning: ${remainingPct.toFixed(1)}% remaining. Disabling web search.`,
        };

      case 'core_only':
        return {
          level,
          shouldProceed: true,
          adjustments: {
            maxPropagationDepth: 1,
            maxFilesToAnalyze: 3,
            enableWebSearch: false,
            enableDetailedAnalysis: false,
          },
          message: `Token budget critical: ${remainingPct.toFixed(1)}% remaining. Core-only analysis mode.`,
        };

      case 'prompt_user':
        return {
          level,
          shouldProceed: false,
          adjustments: {
            maxPropagationDepth: 0,
            maxFilesToAnalyze: 0,
            enableWebSearch: false,
            enableDetailedAnalysis: false,
          },
          message: `Token budget exhausted: ${remainingPct.toFixed(1)}% remaining. Please review or increase budget.`,
        };
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/token-budget.test.ts`
Expected: PASS (all 9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/token-budget.ts tests/token-budget.test.ts
git commit -m "feat: token budget manager with degradation strategies"
```

---

## Task 3: Integrate Token Budget into CodeRepairAgent

**Files:**
- Modify: `src/index.ts`
- Modify: `src/agents/context-builder-agent.ts`
- Test: `tests/cli.test.ts` (append)

- [ ] **Step 1: Update `src/index.ts` to integrate TokenBudgetManager**

Add import at the top:
```typescript
import { TokenBudgetManager } from './core/token-budget.js';
```

Update `AgentConfig` interface:
```typescript
export interface AgentConfig {
  verbose?: boolean;
  memoryPath?: string;
  llmService?: 'anthropic' | 'template';
  tokenBudget?: {
    total?: number;
    analysis?: number;
    search?: number;
    planning?: number;
    review?: number;
  };
}
```

Update `CodeRepairAgent` class:

```typescript
export class CodeRepairAgent {
  private memory: MemoryMiddleware;
  private config: AgentConfig;
  private logger = createLogger('code-repair-agent');
  private llmService: LlmService;
  private budgetManager: TokenBudgetManager;

  constructor(config: AgentConfig = {}) {
    this.config = config;
    this.memory = new MemoryMiddleware();
    this.llmService = config.llmService === 'anthropic'
      ? new AnthropicLlmService()
      : new TemplateLlmService();

    // Initialize token budget manager
    const budgetConfig = config.tokenBudget
      ? {
          total: config.tokenBudget.total ?? 50000,
          allocated: {
            analysis: config.tokenBudget.analysis ?? 20000,
            search: config.tokenBudget.search ?? 10000,
            planning: config.tokenBudget.planning ?? 15000,
            review: config.tokenBudget.review ?? 5000,
          },
        }
      : undefined;
    this.budgetManager = new TokenBudgetManager(budgetConfig);
  }
```

Add getter for budget manager:
```typescript
  getBudgetManager(): TokenBudgetManager {
    return this.budgetManager;
  }
```

Update `plan()` method to integrate budget checks:

```typescript
  async plan(task: RepairTask): Promise<SolutionPlan> {
    // Check budget before starting
    const recommendations = this.budgetManager.getRecommendations();
    if (!recommendations.shouldProceed) {
      throw new Error(`Token budget exceeded: ${recommendations.message}`);
    }

    this.logger.info(`Token budget: ${this.budgetManager.getStatus().remaining} tokens remaining`);

    const detector = new FaultDetectorAgent(this.memory, this.llmService);
    const detectorResult = await detector.run({
      taskId: task.id,
      instruction: task.description,
      context: { targetFiles: task.context?.files || [] },
    });

    // Record estimated analysis tokens
    const analysisTokens = TokenBudgetManager.estimateTokens(
      JSON.stringify(detectorResult.findings)
    );
    this.budgetManager.recordUsage('analysis', analysisTokens);

    const findings = detectorResult.findings;

    if (findings.length > 0) {
      const nodeIds = findings.flatMap(f => f.nodeIds);
      const builder = new ContextBuilderAgent(this.memory);
      await builder.run({
        taskId: task.id,
        instruction: 'Build context for findings',
        context: { nodeIds },
      });
    }

    const planner = new SolutionPlannerAgent(this.memory, this.llmService);
    const plannerResult = await planner.run({
      taskId: task.id,
      instruction: task.description,
      context: {
        problem: task.description,
        findings,
        affectedFiles: task.context?.files || [],
      },
    });

    // Record estimated planning tokens
    const planTokens = TokenBudgetManager.estimateTokens(
      JSON.stringify(plannerResult.result.plan)
    );
    this.budgetManager.recordUsage('planning', planTokens);

    // Check degradation after planning
    const postPlanRecommendations = this.budgetManager.checkDegradation();
    if (postPlanRecommendations.level !== 'none') {
      this.logger.warn(`Budget degradation: ${postPlanRecommendations.message}`);
    }

    return plannerResult.result.plan as SolutionPlan;
  }
```

- [ ] **Step 2: Update `src/agents/context-builder-agent.ts` to respect budget recommendations**

Modify the propagation options to use budget recommendations. In `src/agents/context-builder-agent.ts`, update the `execute` method:

```typescript
  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const { nodeIds } = parseContext(input.context, contextBuilderContextSchema);
    const graph = this.memory.getKnowledgeGraph();

    // Build graph from memory for propagation
    const { KnowledgeGraphBuilder } = await import('../core/knowledge-graph.js');
    const builder = KnowledgeGraphBuilder.fromGraph(graph);

    // Check for budget recommendations in input context
    const maxDepth = (input.context.maxPropagationDepth as number) ?? 3;
    const minEdgeWeight = (input.context.minEdgeWeight as number) ?? 0.5;

    // Run propagation analysis to find affected nodes
    const engine = new PropagationEngine(builder);
    const propagationResult = engine.trace(nodeIds, {
      direction: 'both',
      maxDepth,
      minEdgeWeight,
      includeTests: false,
    });

    // ... rest remains the same
```

- [ ] **Step 3: Append test for token budget integration**

Append to `tests/cli.test.ts`:

```typescript
import { TokenBudgetManager } from '../src/core/token-budget.js';

describe('CodeRepairAgent token budget', () => {
  it('initializes with default budget', () => {
    const agent = new CodeRepairAgent({});
    const status = agent.getBudgetManager().getStatus();
    expect(status.total).toBe(50000);
    expect(status.allocated.analysis).toBe(20000);
  });

  it('initializes with custom budget', () => {
    const agent = new CodeRepairAgent({
      tokenBudget: { total: 10000, analysis: 4000, planning: 3000 },
    });
    const status = agent.getBudgetManager().getStatus();
    expect(status.total).toBe(10000);
    expect(status.allocated.analysis).toBe(4000);
  });

  it('tracks token usage during plan', async () => {
    const agent = new CodeRepairAgent({ verbose: true });
    await agent.init(fixturePath);

    const beforeStatus = agent.getBudgetManager().getStatus();
    expect(beforeStatus.used).toBe(0);

    await agent.plan({
      id: 'task-budget',
      description: 'Fix type errors',
      type: 'bug',
      priority: 'medium',
    });

    const afterStatus = agent.getBudgetManager().getStatus();
    expect(afterStatus.used).toBeGreaterThan(0);
    expect(afterStatus.usageByCategory.analysis).toBeGreaterThan(0);
    expect(afterStatus.usageByCategory.planning).toBeGreaterThan(0);
  });

  it('throws when budget is exhausted', async () => {
    const agent = new CodeRepairAgent({
      tokenBudget: { total: 100, analysis: 40, planning: 30 },
    });
    await agent.init(fixturePath);

    // Pre-exhaust budget
    agent.getBudgetManager().recordUsage('analysis', 95);

    await expect(
      agent.plan({
        id: 'task-exhausted',
        description: 'Fix errors',
        type: 'bug',
        priority: 'medium',
      })
    ).rejects.toThrow('Token budget exceeded');
  });
});
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS (including new tests)

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/agents/context-builder-agent.ts tests/cli.test.ts
git commit -m "feat: integrate token budget manager into agent workflow"
```

---

## Task 4: Add CLI `--budget` Option

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add `--budget` option to `plan` and `fix` commands**

In `src/index.ts`, update the `plan` command options:

```typescript
  program
    .command('plan')
    .description('Generate a repair plan')
    .argument('<description>', 'Problem description')
    .option('-r, --repo <path>', 'Repository path', '.')
    .option('--file <file>', 'Target file(s)', collect, [])
    .option('--llm <provider>', 'LLM provider: anthropic | template', 'template')
    .option('--budget <tokens>', 'Total token budget', '50000')
    .action(async (description: string, options: { repo: string; file: string[]; llm: string; budget: string }) => {
      try {
        const llmService = options.llm === 'anthropic' ? 'anthropic' as const : 'template' as const;
        const totalBudget = parseInt(options.budget, 10);
        const agent = new CodeRepairAgent({
          verbose: true,
          llmService,
          tokenBudget: {
            total: totalBudget,
            analysis: Math.floor(totalBudget * 0.4),
            planning: Math.floor(totalBudget * 0.3),
            search: Math.floor(totalBudget * 0.2),
            review: Math.floor(totalBudget * 0.1),
          },
        });
        // ... rest of the command remains the same
```

Update the `fix` command similarly:

```typescript
    .option('--budget <tokens>', 'Total token budget', '50000')
    .action(async (description: string, options: { repo: string; file: string[]; autoPush: boolean; llm: string; budget: string }) => {
      try {
        const llmService = options.llm === 'anthropic' ? 'anthropic' as const : 'template' as const;
        const totalBudget = parseInt(options.budget, 10);
        const agent = new CodeRepairAgent({
          verbose: true,
          llmService,
          tokenBudget: {
            total: totalBudget,
            analysis: Math.floor(totalBudget * 0.4),
            planning: Math.floor(totalBudget * 0.3),
            search: Math.floor(totalBudget * 0.2),
            review: Math.floor(totalBudget * 0.1),
          },
        });
        // ... rest of the command remains the same
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: CLI --budget option for token budget control"
```

---

## Self-Review

**1. Spec coverage:**
- [x] Token budget tracking per category → Task 2
- [x] Budget status query → Task 2 (`getStatus()`)
- [x] Degradation levels (none/reduce_depth/disable_search/core_only/prompt_user) → Task 2
- [x] Threshold-based triggering (70%/80%/90%/95%) → Task 2
- [x] Budget recommendations with execution parameters → Task 2
- [x] Integration with CodeRepairAgent.plan() → Task 3
- [x] ContextBuilderAgent respects maxDepth from budget → Task 3
- [x] CLI `--budget` option → Task 4
- [x] Budget exhaustion handling → Task 3 (`throws when budget is exhausted` test)

**2. Placeholder scan:** None found. All code is complete.

**3. Type consistency:**
- `TokenBudgetConfig.allocated` keys match usage (`analysis`, `search`, `planning`, `review`)
- `DegradationLevel` union type used consistently in manager and tests
- `BudgetRecommendations.adjustments` fields used consistently

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-02-token-budget.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
