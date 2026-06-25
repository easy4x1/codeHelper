#!/usr/bin/env node

import { Command } from 'commander';
import { MemoryMiddleware } from './core/memory.js';
import { RepoScannerAgent } from './agents/repo-scanner-agent.js';
import { buildImportMap } from './core/repo-scanner.js';
import { FaultDetectorAgent } from './agents/fault-detector-agent.js';
import { ContextBuilderAgent } from './agents/context-builder-agent.js';
import { SolutionPlannerAgent } from './agents/solution-planner-agent.js';
import { WebSearcherAgent } from './agents/web-searcher-agent.js';
import { buildGraphFromFingerprints } from './core/graph-build.js';
import { writeFile, readFile, access, mkdir, stat } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { pathToFileURL } from 'url';
import { createLogger } from './utils/logger.js';
import type { RepairTask, SolutionPlan, ApplyPlanOptions, RepairOutcome, ReviewContext } from './core/types.js';
import { PatchGeneratorAgent } from './agents/patch-generator-agent.js';
import { applyPatch, type FilePatch, type PatchResult } from './core/patch.js';
import { syncRepo } from './core/sync.js';
import { formatDiff, formatPatchResult, createReviewPrompt } from './interface/cli-review.js';
import { createInterface } from 'readline';
import { createLlmService, type LlmService } from './core/llm-service.js';
import { TokenBudgetManager } from './core/token-budget.js';
import { LlmConfigResolver } from './core/llm-config.js';
import { ModelAwareTokenEstimator } from './core/token-estimator.js';
import { GitExecutorAgent } from './agents/git-executor-agent.js';
import { RootCauseAnalyzerAgent } from './agents/root-cause-analyzer-agent.js';
import type { GitExecutionConfig } from './core/git-executor.js';
import { SemanticCache } from './core/semantic-cache.js';
import { ResultCache } from './core/result-cache.js';
import { LearningAgent } from './agents/learning-agent.js';
import { MetricsCollector, setGlobalMetricsCollector } from './core/metrics.js';

export interface AgentConfig {
  verbose?: boolean;
  memoryPath?: string;
  /** @deprecated Use `provider` instead */
  llmService?: string;
  /** LLM provider: anthropic | openai | moonshot | deepseek | zhipu | template */
  provider?: string;
  /** Model name (e.g. 'claude-sonnet-4-6', 'kimi-k2.5', 'glm-5.1', 'gpt-5.4') */
  model?: string;
  tokenBudget?: {
    total?: number;
    analysis?: number;
    search?: number;
    planning?: number;
    review?: number;
  };
  /** Enable web search for solutions (default: true) */
  webSearch?: boolean;
  /** Git execution configuration */
  git?: Partial<GitExecutionConfig>;
}

export class CodeRepairAgent {
  private memory: MemoryMiddleware;
  private config: AgentConfig;
  private logger = createLogger('code-repair-agent');
  private llmService: LlmService;
  private budgetManager: TokenBudgetManager;
  private semanticCache = new SemanticCache();
  private resultCache = new ResultCache();
  private metrics: MetricsCollector;

  constructor(config: AgentConfig = {}) {
    this.config = config;
    this.memory = new MemoryMiddleware();

    // Initialize metrics collector
    this.metrics = new MetricsCollector({
      path: config.memoryPath ? config.memoryPath.replace('memory.json', 'metrics.json') : '.repair-agent/metrics.json',
      autoFlushIntervalMs: 30000, // flush every 30s
    });
    setGlobalMetricsCollector(this.metrics);

    // Resolve LLM provider configuration securely
    // Auto-detect from environment if no provider specified
    const provider = config.provider ?? config.llmService;
    const resolved = new LlmConfigResolver().resolve(provider, config.model);
    this.llmService = createLlmService(resolved?.config ?? null);

    // Token estimator tied to the selected model for accurate budget tracking
    const modelName = resolved?.config.model ?? 'default';
    const estimator = new ModelAwareTokenEstimator(modelName);
    this.budgetManager = new TokenBudgetManager(
      config.tokenBudget
        ? {
            total: config.tokenBudget.total ?? 50000,
            allocated: {
              analysis: config.tokenBudget.analysis ?? 20000,
              search: config.tokenBudget.search ?? 10000,
              planning: config.tokenBudget.planning ?? 15000,
              review: config.tokenBudget.review ?? 5000,
            },
          }
        : undefined,
      estimator
    );
  }

  getBudgetManager(): TokenBudgetManager {
    return this.budgetManager;
  }

  getMetrics(): MetricsCollector {
    return this.metrics;
  }

  /**
   * Infer the repository's primary language from fingerprints (falling back to
   * the task's target files), so web-search queries are tagged correctly.
   */
  private detectPrimaryLanguage(task?: RepairTask): string {
    const EXT_TO_LANG: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      py: 'python', go: 'go', java: 'java', rb: 'ruby', php: 'php',
      rs: 'rust', cs: 'csharp', cpp: 'cpp', c: 'c', kt: 'kotlin', swift: 'swift',
    };
    const counts = new Map<string, number>();
    const tally = (path: string) => {
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
      const lang = EXT_TO_LANG[ext];
      if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
    };

    for (const path of Object.keys(this.memory.getAllFingerprints())) tally(path);
    if (counts.size === 0) {
      for (const path of task?.context?.files ?? []) tally(path);
    }

    // Deliberate default bias (not a detected value): this project is
    // TypeScript-first, so fall back to 'typescript' when nothing matched.
    let best = 'typescript';
    let bestCount = 0;
    for (const [lang, count] of counts) {
      if (count > bestCount) { best = lang; bestCount = count; }
    }
    return best;
  }

  async init(repoPath: string): Promise<{ files: string[]; fingerprintCount: number }> {
    const resolvedPath = resolve(repoPath);
    const stats = await stat(resolvedPath);
    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${repoPath}`);
    }

    const scanner = new RepoScannerAgent(this.memory);
    const result = await scanner.run({
      taskId: `init-${Date.now()}`,
      instruction: 'Initialize repository scan',
      context: { repoPath: resolve(repoPath) },
    });

    // Build the knowledge graph from fingerprints (contains/imports/exports +
    // cross-file calls/inherits + symbol-level import resolution).
    const fingerprints = this.memory.getAllFingerprints();
    this.memory.setKnowledgeGraph(buildGraphFromFingerprints(fingerprints));

    const files = result.result.files as string[];

    // Record graph metrics
    const graph = this.memory.getKnowledgeGraph();
    this.metrics.recordGraphSize(graph.nodes.length, graph.edges.length, files.length);

    return {
      files,
      fingerprintCount: files.length,
    };
  }

  /**
   * Analyze a task and produce a SolutionPlan (no changes applied).
   *
   * `options.recordMetric` controls whether this call emits its own `plan`
   * task metric (default true). Workflow callers that record their own
   * task metric — e.g. the CLI `fix` command which records a `fix` task —
   * pass `false` so a single user action does not double-count as plan+fix.
   */
  async plan(task: RepairTask, options?: { recordMetric?: boolean }): Promise<SolutionPlan> {
    const recordMetric = options?.recordMetric ?? true;
    const taskStart = Date.now();
    const recommendations = this.budgetManager.getRecommendations();
    if (!recommendations.shouldProceed) {
      throw new Error('Token budget exceeded: ' + recommendations.message);
    }

    const status = this.budgetManager.getStatus();
    this.logger.info(`Token budget: ${status.remaining} tokens remaining`);

    // Phase 3: Semantic Cache — check for similar past tasks
    const cachedPlan = this.semanticCache.findSimilar(task.description);
    if (cachedPlan) {
      this.logger.info('Semantic cache hit — returning cached plan');
      // Record the task so cache hits remain visible to metrics (0 tokens = the saving)
      if (recordMetric) {
        this.metrics.recordTask('plan', true, Date.now() - taskStart, 0);
        await this.metrics.flush();
      }
      return cachedPlan;
    }

    const detector = new FaultDetectorAgent(this.memory, this.llmService, this.resultCache);
    const detectorResult = await detector.run({
      taskId: task.id,
      instruction: task.description,
      context: { targetFiles: task.context?.files || [] },
    });

    const findings = detectorResult.findings;

    const analysisTokens = TokenBudgetManager.estimateTokens(JSON.stringify(detectorResult.findings));
    this.budgetManager.recordUsage('analysis', analysisTokens);

    let propagationResult: Record<string, unknown> | undefined;
    if (findings.length > 0) {
      const nodeIds = findings.flatMap(f => f.nodeIds);
      const builder = new ContextBuilderAgent(this.memory);
      const contextOutput = await builder.run({
        taskId: task.id,
        instruction: 'Build context for findings',
        context: {
          nodeIds,
          // Couple propagation depth to the token budget's degradation policy.
          maxPropagationDepth: recommendations.adjustments.maxPropagationDepth,
        },
      });
      propagationResult = contextOutput.result.propagationResult as Record<string, unknown> | undefined;
    }

    // ---- Web Search (Phase 3) ----
    let searchResults: Array<{ title: string; url: string; snippet: string; credibilityScore: number }> = [];
    const budgetRecs = this.budgetManager.getRecommendations();
    const shouldSearch = this.config.webSearch !== false && budgetRecs.adjustments.enableWebSearch !== false && findings.length > 0;

    if (shouldSearch) {
      this.logger.info('Web search enabled by budget and config');
    } else if (budgetRecs.adjustments.enableWebSearch === false) {
      this.logger.info('Web search disabled by token budget degradation');
    }

    if (shouldSearch) {
      const webSearcher = new WebSearcherAgent(this.memory);
      const searchOutput = await webSearcher.run({
        taskId: task.id,
        instruction: 'Search web for solutions',
        context: {
          findings,
          language: this.detectPrimaryLanguage(task),
        },
      });
      searchResults = (searchOutput.result.searchResults as typeof searchResults) || [];

      // Record token usage for search
      const searchTokens = searchResults.reduce((sum, r) => sum + r.title.length + r.snippet.length, 0);
      this.budgetManager.recordUsage('search', Math.ceil(searchTokens / 4));
    }

    // ---- Root Cause Analysis (Phase 2.5) ----
    const rootCauseAnalyzer = new RootCauseAnalyzerAgent(this.memory, this.llmService);
    const rootCauseResult = await rootCauseAnalyzer.run({
      taskId: task.id,
      instruction: 'Analyze root cause',
      context: {
        problem: task.description,
        findings,
        codeContext: [],  // Will be loaded by agent from findings
        searchResults: searchResults.map(r => ({
          title: r.title,
          snippet: r.snippet,
          credibility: r.credibilityScore,
        })),
        // Feed graph propagation (affected nodes + root-cause candidates) into analysis.
        propagationResult,
      },
    });

    const rootCause = rootCauseResult.result.rootCause as string;
    const severity = rootCauseResult.result.severity as string;
    const affectedFiles = rootCauseResult.result.affectedFiles as string[];

    this.logger.info(`Root cause: ${rootCause} (severity: ${severity})`);

    const planner = new SolutionPlannerAgent(this.memory, this.llmService);
    const plannerResult = await planner.run({
      taskId: task.id,
      instruction: task.description,
      context: {
        problem: task.description,
        findings,
        affectedFiles: affectedFiles.length > 0 ? affectedFiles : (task.context?.files || []),
        repoPath: '.',
        searchResults: searchResults.map(r => ({
          title: r.title,
          snippet: r.snippet,
          credibility: r.credibilityScore,
        })),
        rootCause,
        severity,
      },
    });

    const planningTokens = TokenBudgetManager.estimateTokens(JSON.stringify(plannerResult.result));
    this.budgetManager.recordUsage('planning', planningTokens);

    const degradation = this.budgetManager.checkDegradation();
    if (degradation.level !== 'none') {
      this.logger.warn(`Token budget degradation: ${degradation.level} — ${degradation.message}`);
    }

    const plan = plannerResult.result.plan as SolutionPlan;

    // Phase 3: Semantic Cache — store plan for future reuse
    this.semanticCache.store(task.description, plan);

    const taskDuration = Date.now() - taskStart;
    const tokensUsed = this.budgetManager.getStatus().used;
    if (recordMetric) {
      this.metrics.recordTask('plan', true, taskDuration, tokensUsed);
      await this.metrics.flush();
    }

    return plan;
  }

  async saveMemory(path: string): Promise<void> {
    // Sync token budget state into L2 for cross-session tracking
    this.memory.setTokenBudget(this.budgetManager.getStatus());
    // Persist semantic cache so plan reuse survives across CLI invocations
    this.memory.setSemanticCache(this.semanticCache.export());
    // Persist result cache so unchanged-file analysis reuse survives across runs
    this.memory.setResultCache(this.resultCache.export());
    const serialized = this.memory.serialize();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serialized, 'utf-8');
  }

  async loadMemory(path: string): Promise<void> {
    try {
      const data = await readFile(path, 'utf-8');
      this.memory = MemoryMiddleware.deserialize(data);
      // Restore token budget from L2 for cross-session tracking
      const savedBudget = this.memory.getTokenBudget();
      if (savedBudget) {
        this.budgetManager.restoreSnapshot(savedBudget);
      }
      // Hydrate semantic cache from persisted entries
      this.semanticCache.load(this.memory.getSemanticCache());
      // Hydrate result cache from persisted entries
      this.resultCache.load(this.memory.getResultCache());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.error(`Failed to load memory from ${path}:`, err);
        throw err;
      }
      // File doesn't exist, use fresh memory
    }
  }

  getMemory(): MemoryMiddleware {
    return this.memory;
  }

  // ---- Plan persistence ----

  async savePlan(plan: SolutionPlan, repoPath: string): Promise<string> {
    const plansDir = join(resolve(repoPath), '.repair-agent', 'plans');
    await mkdir(plansDir, { recursive: true });
    const planPath = join(plansDir, `${plan.id}.json`);
    await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');
    return planPath;
  }

  async loadPlan(planId: string, repoPath: string): Promise<SolutionPlan | null> {
    const planPath = join(resolve(repoPath), '.repair-agent', 'plans', `${planId}.json`);
    try {
      const data = await readFile(planPath, 'utf-8');
      return JSON.parse(data) as SolutionPlan;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.logger.warn(`Plan not found: ${planId}`);
        return null;
      }
      throw err;
    }
  }

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

  /**
   * Turn a SolutionPlan into applied changes: patch → review → apply → git → record.
   * This is the single orchestration path shared by `repair()`, `apply()` and the
   * CLI fix/apply/batch commands. It performs no console I/O — interactive front-ends
   * inject an `options.review` gate and render the returned RepairOutcome themselves.
   */
  async applyPlan(plan: SolutionPlan, options: ApplyPlanOptions = {}): Promise<RepairOutcome> {
    const { dryRun = false, push = true, review, record = true } = options;

    // 1. Generate patches from the plan
    const patchGenerator = new PatchGeneratorAgent(this.memory, this.llmService);
    const patchOutput = await patchGenerator.run({
      taskId: plan.taskId,
      instruction: 'Generate patches for the plan',
      context: { plan },
    });
    const patches = patchOutput.result.patches as FilePatch[];
    const summary = patchOutput.result.summary as PatchResult['summary'];

    const outcome: RepairOutcome = {
      plan,
      patches,
      summary,
      approved: false,
      applied: [],
      failed: [],
    };

    // 2. Dry run — stop before touching disk
    if (dryRun) {
      return outcome;
    }

    // 3. Review gate (default: approve)
    const approved = review ? await review({ plan, patches, summary }) : true;
    if (!approved) {
      return outcome;
    }
    outcome.approved = true;

    // 4. Apply patches
    const { applied, failed } = await this.applyPatches(patches);
    outcome.applied = applied;
    outcome.failed = failed;

    // 5. Git workflow (commit/push)
    if (push && applied.length > 0) {
      const gitAgent = new GitExecutorAgent(this.config.git);
      const gitOutput = await gitAgent.run({
        taskId: `git-${Date.now()}`,
        instruction: 'Commit and push changes',
        context: { files: applied, description: plan.problem.description },
      });
      const g = gitOutput.result as { success: boolean; messages?: string[]; errors?: string[]; prUrl?: string };
      outcome.git = { success: g.success, messages: g.messages || [], errors: g.errors || [], prUrl: g.prUrl };
    }

    // 6. Record completed task into L3 learned memory
    if (record) {
      const learningAgent = new LearningAgent(this.memory);
      learningAgent.recordTaskCompletion(
        plan.taskId,
        plan.problem.description,
        applied,
        plan.changes.length,
        applied.length > 0,
        undefined,
        plan,
      );
    }

    return outcome;
  }

  /** Load a persisted plan by id and apply it. Mirrors DESIGN §6.2 `apply()`. */
  async apply(planId: string, repoPath: string, options: ApplyPlanOptions = {}): Promise<RepairOutcome> {
    const plan = await this.loadPlan(planId, repoPath);
    if (!plan) {
      throw new Error(`Plan not found: ${planId}`);
    }
    return this.applyPlan(plan, options);
  }

  /** Full closed loop: analyze → plan → apply. Mirrors DESIGN §6.2 `repair()`. */
  async repair(task: RepairTask, options: ApplyPlanOptions = {}): Promise<RepairOutcome> {
    const plan = await this.plan(task);
    return this.applyPlan(plan, options);
  }
}

/**
 * Render the git portion of a RepairOutcome to the terminal.
 * Returns false when the git workflow ran and failed (caller decides on exit code).
 */
function printGitOutcome(outcome: RepairOutcome): boolean {
  if (!outcome.git) return true;
  if (outcome.git.success) {
    console.log('\n✅ Git workflow complete');
    for (const msg of outcome.git.messages) console.log(`  → ${msg}`);
    if (outcome.git.prUrl) console.log(`\n🔗 Pull request: ${outcome.git.prUrl}`);
    return true;
  }
  console.log('\n⚠️ Git workflow failed');
  for (const err of outcome.git.errors) console.log(`  ✗ ${err}`);
  return false;
}

// CLI setup
async function main(): Promise<void> {
  const program = new Command();

  program
    .name('code-agent')
    .description('AI-powered code repair agent')
    .version('0.5.0');

  program
    .command('init')
    .description('Initialize agent for a repository')
    .argument('[repo-path]', 'Path to repository', '.')
    .action(async (repoPath: string) => {
      try {
        const agent = new CodeRepairAgent({ verbose: true });
        const result = await agent.init(repoPath);
        await agent.saveMemory(join(resolve(repoPath), '.repair-agent', 'memory.json'));
        console.log(`Initialized: ${result.fingerprintCount} files scanned`);
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
    });

  program
    .command('plan')
    .description('Generate a repair plan')
    .argument('<description>', 'Problem description')
    .option('-r, --repo <path>', 'Repository path', '.')
    .option('--file <file>', 'Target file(s)', collect, [])
    .option('--provider <name>', 'LLM provider: anthropic | openai | moonshot | deepseek | zhipu | template (auto-detected from env if not specified)')
    .option('--model <name>', 'Model name (e.g. claude-sonnet-4-6, kimi-k2.5, glm-5.1, gpt-5.4)')
    .option('--budget <tokens>', 'Total token budget', '50000')
    .option('--web-search', 'Enable web search for solutions', true)
    .option('--no-web-search', 'Disable web search for solutions')
    .action(async (description: string, options: { repo: string; file: string[]; provider: string; model?: string; budget: string; webSearch: boolean }) => {
      try {
        const total = parseInt(options.budget, 10);
        const agent = new CodeRepairAgent({
          verbose: true,
          provider: options.provider,
          model: options.model,
          webSearch: options.webSearch,
          tokenBudget: {
            total,
            analysis: Math.floor(total * 0.4),
            planning: Math.floor(total * 0.3),
            search: Math.floor(total * 0.2),
            review: Math.floor(total * 0.1),
          },
        });
        const memoryPath = join(resolve(options.repo), '.repair-agent', 'memory.json');
        await agent.loadMemory(memoryPath);

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
        const planPath = await agent.savePlan(plan, options.repo);

        // Record plan generation for learning
        const learningAgent = new LearningAgent(agent.getMemory());
        learningAgent.recordTaskCompletion(
          task.id,
          task.description,
          task.context?.files || [],
          plan.changes.length,
          true, // plan generation always "succeeds"
          undefined,
          plan
        );
        await agent.saveMemory(memoryPath);

        console.log('\n=== Solution Plan ===\n');
        console.log(`ID: ${plan.id}`);
        console.log(`Problem: ${plan.problem.description}`);
        console.log(`Root Cause: ${plan.problem.rootCause}`);
        console.log(`\nChanges (${plan.changes.length}):`);
        for (const change of plan.changes) {
          console.log(`  - ${change.filePath}: ${change.description}`);
        }
        console.log(`\nConfidence: ${(plan.metadata.confidence * 100).toFixed(1)}%`);
        console.log(`\nPlan saved to: ${planPath}`);
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
    });

  program
    .command('status')
    .description('Show knowledge graph status')
    .argument('[repo-path]', 'Path to repository', '.')
    .action(async (repoPath: string) => {
      try {
        const agent = new CodeRepairAgent({});
        const memoryPath = join(resolve(repoPath), '.repair-agent', 'memory.json');
        await agent.loadMemory(memoryPath);
        const memory = agent.getMemory();
        const graph = memory.getKnowledgeGraph();
        const fingerprints = memory.getAllFingerprints();
        console.log(`Nodes: ${graph.nodes.length}`);
        console.log(`Edges: ${graph.edges.length}`);
        console.log(`Fingerprints: ${Object.keys(fingerprints).length}`);
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
    });

  program
    .command('sync')
    .description('Incremental sync: update knowledge graph based on file changes')
    .argument('[repo-path]', 'Path to repository', '.')
    .option('--force-full', 'Force full re-analysis of all files', false)
    .action(async (repoPath: string, options: { forceFull: boolean }) => {
      try {
        const agent = new CodeRepairAgent({ verbose: true });
        const memoryPath = join(resolve(repoPath), '.repair-agent', 'memory.json');
        await agent.loadMemory(memoryPath);

        const syncStart = Date.now();
        const result = await syncRepo(agent.getMemory(), {
          repoPath: resolve(repoPath),
          forceFull: options.forceFull,
        });

        // Update memory with sync results
        const memory = agent.getMemory();
        const repoMemory = memory.getRepoMemory();
        repoMemory.knowledgeGraph = result.updatedGraph;
        repoMemory.fingerprints = result.updatedFingerprints;
        repoMemory.importMap = buildImportMap(Object.values(result.updatedFingerprints));
        memory.setRepoMemory(repoMemory);

        await agent.saveMemory(memoryPath);

        // Record incremental savings metrics
        const filesSkipped = result.filesUnchanged + result.filesCosmetic;
        const filesReanalyzed = result.filesStructural + result.filesAdded + result.filesDeleted;
        const estimatedTokensSaved = filesSkipped * 500; // rough estimate: 500 tokens per skipped file
        agent.getMetrics().recordIncrementalSavings(filesSkipped, filesReanalyzed, estimatedTokensSaved);

        const syncDuration = Date.now() - syncStart;
        agent.getMetrics().recordTask('sync', true, syncDuration, 0);
        await agent.getMetrics().flush();

        console.log('\n=== Sync Complete ===');
        console.log(`Files analyzed: ${result.filesAnalyzed}`);
        console.log(`  Unchanged:  ${result.filesUnchanged}`);
        console.log(`  Cosmetic:   ${result.filesCosmetic}`);
        console.log(`  Structural: ${result.filesStructural}`);
        console.log(`  Added:      ${result.filesAdded}`);
        console.log(`  Deleted:    ${result.filesDeleted}`);

        if (result.changes.length > 0) {
          console.log('\nChanges:');
          for (const change of result.changes) {
            const icon = change.changeLevel === 'NONE' ? '✓' :
              change.changeLevel === 'COSMETIC' ? '○' :
              change.changeLevel === 'STRUCTURAL' ? '△' : '?';
            console.log(`  ${icon} ${change.filePath} (${change.changeLevel})`);
          }
        }
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
    });

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

        // Load persisted plan
        const plan = await agent.loadPlan(planId, options.repo);
        if (!plan) {
          console.error(`Plan not found: ${planId}`);
          console.error(`Expected at: ${join(resolve(options.repo), '.repair-agent', 'plans', `${planId}.json`)}`);
          process.exit(1);
        }

        console.log(`\n=== Applying Plan: ${plan.id} ===`);
        console.log(`Problem: ${plan.problem.description}`);
        console.log(`Changes: ${plan.changes.length} file(s)`);

        const outcome = await agent.applyPlan(plan, { dryRun: options.dryRun, push: true });

        if (options.dryRun) {
          console.log('\n--- Dry Run (no changes applied) ---');
          for (const patch of outcome.patches) {
            console.log(formatDiff(patch));
          }
          return;
        }

        console.log(`\nApplied: ${outcome.applied.length} file(s)`);
        if (outcome.failed.length > 0) {
          console.log(`Failed: ${outcome.failed.join(', ')}`);
          process.exit(1);
        }

        if (!printGitOutcome(outcome)) {
          process.exit(1);
        }
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
    .option('--file <file>', 'Target file(s)', (val: string, prev: string[]) => prev.concat([val]), [])
    .option('--auto-push', 'Automatically apply without confirmation', false)
    .option('--llm <provider>', 'LLM provider: anthropic | template (auto-detected from env if not specified)')
    .option('--budget <tokens>', 'Total token budget', '50000')
    .option('--web-search', 'Enable web search for solutions', true)
    .option('--no-web-search', 'Disable web search for solutions')
    .option('--create-pr', 'Open a pull request after pushing (uses gh CLI, falls back to a compare URL)', false)
    .action(async (description: string, options: { repo: string; file: string[]; autoPush: boolean; llm?: string; budget: string; webSearch: boolean; createPr: boolean }) => {
      const fixStart = Date.now();
      try {
        const llmService = options.llm;
        const total = parseInt(options.budget, 10);
        const agent = new CodeRepairAgent({
          verbose: true,
          llmService,
          webSearch: options.webSearch,
          git: options.createPr ? { push: { remote: 'origin', force: false, createPR: true } } : undefined,
          tokenBudget: {
            total,
            analysis: Math.floor(total * 0.4),
            planning: Math.floor(total * 0.3),
            search: Math.floor(total * 0.2),
            review: Math.floor(total * 0.1),
          },
        });
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

        // This is the `fix` workflow; it records its own `fix` task metric
        // below, so suppress the inner `plan` metric to avoid double-counting.
        const plan = await agent.plan(task, { recordMetric: false });
        console.log('\n=== Solution Plan ===\n');
        console.log(`ID: ${plan.id}`);
        console.log(`Problem: ${plan.problem.description}`);
        console.log(`Root Cause: ${plan.problem.rootCause}`);
        console.log(`\nChanges (${plan.changes.length}):`);
        for (const change of plan.changes) {
          console.log(`  - ${change.filePath}: ${change.description}`);
        }

        // Step 2: Review gate — show patches/diffs, then confirm (interactive)
        const review = async (ctx: ReviewContext): Promise<boolean> => {
          console.log(formatPatchResult({ patches: ctx.patches, summary: ctx.summary }));
          for (const patch of ctx.patches) {
            console.log(formatDiff(patch));
          }

          if (options.autoPush) {
            console.log('Auto-applying (auto-push flag set)...');
            return true;
          }

          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>((resolve) => {
            rl.question(createReviewPrompt(), resolve);
          });
          rl.close();

          const approved = answer.toLowerCase() === 'a' || answer.toLowerCase() === 'approve';
          if (!approved) {
            console.log('Changes rejected. No files modified.');
          }
          return approved;
        };

        // Step 3: Patch → review → apply → git → record (single orchestration path)
        const outcome = await agent.applyPlan(plan, { review, push: true, record: true });

        if (outcome.approved) {
          console.log(`\nApplied: ${outcome.applied.length} file(s)`);
          if (outcome.failed.length > 0) {
            console.log(`Failed: ${outcome.failed.join(', ')}`);
          }
        }
        const gitOk = printGitOutcome(outcome);

        // Record metrics
        const fixDuration = Date.now() - fixStart;
        const tokensUsed = agent.getBudgetManager().getStatus().used;
        agent.getMetrics().recordTask('fix', outcome.applied.length > 0, fixDuration, tokensUsed);
        await agent.getMetrics().flush();

        await agent.saveMemory(memoryPath);

        // Consistent with `apply`: non-zero exit when the git workflow ran and failed
        if (!gitOk) {
          process.exit(1);
        }
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
    });

  program
    .command('batch')
    .description('Batch process multiple repair tasks from a JSON file')
    .argument('<tasks-file>', 'Path to batch tasks JSON file')
    .option('-r, --repo <path>', 'Repository path', '.')
    .option('--auto-push', 'Automatically apply all without confirmation', false)
    .option('--llm <provider>', 'LLM provider: anthropic | template (auto-detected from env if not specified)')
    .option('--budget <tokens>', 'Total token budget per task', '50000')
    .option('--web-search', 'Enable web search', true)
    .option('--no-web-search', 'Disable web search')
    .option('--parallel', 'Run tasks in parallel (experimental)', false)
    .action(async (tasksFile: string, options: {
      repo: string;
      autoPush: boolean;
      llm?: string;
      budget: string;
      webSearch: boolean;
      parallel: boolean;
    }) => {
      try {
        const batchData = JSON.parse(await readFile(resolve(tasksFile), 'utf-8')) as {
          tasks: Array<{ description: string; files?: string[] }>;
          options?: { parallel?: boolean; autoPush?: boolean; webSearch?: boolean };
        };

        if (!Array.isArray(batchData.tasks) || batchData.tasks.length === 0) {
          console.error('Invalid batch file: tasks array required');
          process.exit(1);
        }

        const llmService = options.llm;
        const total = parseInt(options.budget, 10);
        const autoPush = options.autoPush || batchData.options?.autoPush || false;
        const webSearch = options.webSearch !== false && batchData.options?.webSearch !== false;
        const parallel = options.parallel || batchData.options?.parallel || false;

        console.log(`\n=== Batch Processing: ${batchData.tasks.length} task(s) ===`);
        console.log(`Mode: ${parallel ? 'parallel' : 'sequential'}`);
        console.log(`Auto-push: ${autoPush}`);
        console.log(`Web search: ${webSearch}\n`);

        const results: Array<{ task: string; success: boolean; planId?: string; error?: string }> = [];

        const processTask = async (taskDesc: string, files: string[], index: number): Promise<void> => {
          const taskId = `batch-${Date.now()}-${index}`;
          console.log(`\n[${index + 1}/${batchData.tasks.length}] ${taskDesc}`);

          try {
            const agent = new CodeRepairAgent({
              verbose: true,
              llmService,
              webSearch,
              tokenBudget: {
                total,
                analysis: Math.floor(total * 0.4),
                planning: Math.floor(total * 0.3),
                search: Math.floor(total * 0.2),
                review: Math.floor(total * 0.1),
              },
            });

            const memoryPath = join(resolve(options.repo), '.repair-agent', 'memory.json');
            await agent.loadMemory(memoryPath);

            const task: RepairTask = {
              id: taskId,
              description: taskDesc,
              type: 'bug',
              priority: 'medium',
              context: { files: files.length > 0 ? files : undefined },
            };

            const plan = await agent.plan(task);
            const planPath = await agent.savePlan(plan, options.repo);
            await agent.saveMemory(memoryPath);

            console.log(`  Plan: ${plan.id} (${plan.changes.length} change(s))`);

            if (autoPush) {
              // Auto-apply via the shared orchestration path (default approve).
              const outcome = await agent.applyPlan(plan, { push: true, record: true });
              if (outcome.applied.length > 0) {
                console.log(`  ✅ Applied + committed`);
              }
            } else {
              console.log(`  💾 Plan saved. Apply with: code-agent apply ${plan.id}`);
            }

            results.push({ task: taskDesc, success: true, planId: plan.id });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`  ❌ Failed: ${msg}`);
            results.push({ task: taskDesc, success: false, error: msg });
          }
        };

        if (parallel) {
          await Promise.all(batchData.tasks.map((t, i) => processTask(t.description, t.files || [], i)));
        } else {
          for (let i = 0; i < batchData.tasks.length; i++) {
            await processTask(batchData.tasks[i].description, batchData.tasks[i].files || [], i);
          }
        }

        // Summary
        console.log('\n=== Batch Summary ===');
        const succeeded = results.filter(r => r.success).length;
        console.log(`Success: ${succeeded}/${results.length}`);
        for (const r of results) {
          const icon = r.success ? '✅' : '❌';
          console.log(`  ${icon} ${r.task}${r.planId ? ` → ${r.planId}` : ''}`);
        }

        if (succeeded < results.length) {
          process.exit(1);
        }
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
    });

  program
    .command('history')
    .description('Show task history and learned patterns')
    .option('-r, --repo <path>', 'Repository path', '.')
    .option('--patterns', 'Show fault/fix patterns', false)
    .option('--conventions', 'Show project conventions', false)
    .action(async (options: { repo: string; patterns: boolean; conventions: boolean }) => {
      try {
        const agent = new CodeRepairAgent({});
        const memoryPath = join(resolve(options.repo), '.repair-agent', 'memory.json');
        await agent.loadMemory(memoryPath);
        const memory = agent.getMemory();
        const learned = memory.getLearnedMemory();

        console.log('\n=== Task History ===');
        console.log(`Total tasks: ${learned.taskHistory.length}`);
        for (const task of learned.taskHistory.slice(-10)) {
          const icon = task.success ? '✅' : '❌';
          console.log(`  ${icon} ${task.description} (${task.findingsCount} findings)`);
        }

        if (options.patterns) {
          console.log('\n=== Fault Patterns ===');
          for (const p of learned.faultPatterns.sort((a, b) => b.frequency - a.frequency)) {
            console.log(`  • ${p.pattern} (×${p.frequency})`);
          }
          console.log('\n=== Fix Patterns ===');
          for (const p of learned.fixPatterns.sort((a, b) => b.frequency - a.frequency)) {
            console.log(`  • ${p.pattern} (×${p.frequency})`);
          }
        }

        if (options.conventions) {
          console.log('\n=== Project Conventions ===');
          for (const c of learned.projectConventions) {
            console.log(`  [${c.category}] ${c.rule} (${(c.confidence * 100).toFixed(0)}%)`);
          }
        }
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
    });

  program
    .command('learn')
    .description('Learn project conventions from codebase')
    .argument('[repo-path]', 'Path to repository', '.')
    .action(async (repoPath: string) => {
      const learnStart = Date.now();
      try {
        const codeAgent = new CodeRepairAgent({ verbose: true });
        const memoryPath = join(resolve(repoPath), '.repair-agent', 'memory.json');
        await codeAgent.loadMemory(memoryPath);

        const learningAgent = new LearningAgent(codeAgent.getMemory());
        const result = await learningAgent.run({
          taskId: `learn-${Date.now()}`,
          instruction: 'Learn project conventions',
          context: { repoPath: resolve(repoPath) },
        });

        await codeAgent.saveMemory(memoryPath);

        // Record metrics
        const learnDuration = Date.now() - learnStart;
        codeAgent.getMetrics().recordTask('learn', true, learnDuration, 0);
        await codeAgent.getMetrics().flush();

        console.log('\n=== Learning Complete ===');
        console.log(`Conventions learned: ${result.result.conventionsLearned}`);
        console.log(`Patterns extracted: ${result.result.patternsExtracted}`);

        const conventions = codeAgent.getMemory().getConventions();
        if (conventions.length > 0) {
          console.log('\nLearned conventions:');
          for (const c of conventions) {
            console.log(`  [${c.category}] ${c.rule}`);
          }
        }
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
    });

  program
    .command('metrics')
    .description('Show application performance metrics')
    .option('-r, --repo <path>', 'Repository path', '.')
    .option('--json', 'Output raw JSON', false)
    .option('--reset', 'Reset all metrics', false)
    .action(async (options: { repo: string; json: boolean; reset: boolean }) => {
      try {
        const metricsPath = join(resolve(options.repo), '.repair-agent', 'metrics.json');

        if (options.reset) {
          const collector = new MetricsCollector({ path: metricsPath });
          await collector.reset();
          console.log('✅ Metrics reset');
          return;
        }

        const collector = new MetricsCollector({ path: metricsPath });
        await collector.load();
        const snapshot = collector.getSnapshot();

        if (options.json) {
          console.log(JSON.stringify(snapshot, null, 2));
          return;
        }

        console.log('\n=== Code Repair Agent Metrics ===\n');

        // Agent metrics
        console.log('📊 Agent Performance');
        console.log('─'.repeat(40));
        const agents = Object.values(snapshot.agents);
        if (agents.length === 0) {
          console.log('  No agent executions recorded yet');
        } else {
          for (const a of agents) {
            const avgMs = a.callCount > 0 ? Math.round(a.totalDurationMs / a.callCount) : 0;
            const successRate = a.callCount > 0 ? ((a.successCount / a.callCount) * 100).toFixed(1) : '0.0';
            console.log(`  ${a.agentName}`);
            console.log(`    Calls: ${a.callCount} | Avg: ${avgMs}ms | Success: ${successRate}%`);
          }
        }

        // Cache metrics
        console.log('\n💾 Semantic Cache');
        console.log('─'.repeat(40));
        const cacheTotal = snapshot.cache.hits + snapshot.cache.misses;
        if (cacheTotal === 0) {
          console.log('  No cache queries recorded yet');
        } else {
          const hitRate = ((snapshot.cache.hits / cacheTotal) * 100).toFixed(1);
          const dist = collector.getCacheSimilarityDistribution();
          console.log(`  Queries: ${cacheTotal} | Hits: ${snapshot.cache.hits} | Misses: ${snapshot.cache.misses}`);
          console.log(`  Hit Rate: ${hitRate}%`);
          console.log(`  Similarity: min=${dist.min.toFixed(2)} max=${dist.max.toFixed(2)} avg=${dist.avg.toFixed(2)} median=${dist.median.toFixed(2)}`);
        }

        // Token metrics
        console.log('\n🔤 Token Usage');
        console.log('─'.repeat(40));
        const totalTokens = Object.values(snapshot.tokens).reduce((s, v) => s + v, 0);
        if (totalTokens === 0) {
          console.log('  No token usage recorded yet');
        } else {
          console.log(`  Total: ${totalTokens.toLocaleString()} tokens`);
          console.log(`  Analysis:  ${snapshot.tokens.analysis.toLocaleString()}`);
          console.log(`  Search:    ${snapshot.tokens.search.toLocaleString()}`);
          console.log(`  Planning:  ${snapshot.tokens.planning.toLocaleString()}`);
          console.log(`  Review:    ${snapshot.tokens.review.toLocaleString()}`);
        }

        // Task metrics
        console.log('\n📋 Tasks');
        console.log('─'.repeat(40));
        if (snapshot.tasks.length === 0) {
          console.log('  No tasks recorded yet');
        } else {
          const byType: Record<string, { total: number; success: number }> = {};
          for (const t of snapshot.tasks) {
            if (!byType[t.taskType]) byType[t.taskType] = { total: 0, success: 0 };
            byType[t.taskType].total++;
            if (t.success) byType[t.taskType].success++;
          }
          for (const [type, stats] of Object.entries(byType)) {
            const rate = ((stats.success / stats.total) * 100).toFixed(1);
            console.log(`  ${type}: ${stats.total} tasks | ${rate}% success`);
          }
        }

        // Parser metrics
        console.log('\n🔍 Parser Coverage');
        console.log('─'.repeat(40));
        const parserTotal = snapshot.parser.treeSitterFiles + snapshot.parser.regexFiles;
        if (parserTotal === 0) {
          console.log('  No files parsed yet');
        } else {
          const tsRate = ((snapshot.parser.treeSitterFiles / parserTotal) * 100).toFixed(1);
          console.log(`  Tree-sitter: ${snapshot.parser.treeSitterFiles} files (${tsRate}%)`);
          console.log(`  Regex:       ${snapshot.parser.regexFiles} files`);
          console.log(`  By language:`);
          for (const [lang, counts] of Object.entries(snapshot.parser.byLanguage)) {
            const langTotal = counts.treeSitter + counts.regex;
            const langRate = langTotal > 0 ? ((counts.treeSitter / langTotal) * 100).toFixed(1) : '0.0';
            console.log(`    ${lang}: ${counts.treeSitter}/${langTotal} TS (${langRate}%)`);
          }
        }

        // Graph metrics
        console.log('\n🕸️  Knowledge Graph');
        console.log('─'.repeat(40));
        console.log(`  Nodes: ${snapshot.graph.nodeCount}`);
        console.log(`  Edges: ${snapshot.graph.edgeCount}`);
        console.log(`  Files: ${snapshot.graph.fileCount}`);

        // Incremental savings
        console.log('\n⏱️  Incremental Analysis Savings');
        console.log('─'.repeat(40));
        console.log(`  Files skipped:     ${snapshot.incrementalSavings.filesSkipped}`);
        console.log(`  Files reanalyzed:  ${snapshot.incrementalSavings.filesReanalyzed}`);
        console.log(`  Est. tokens saved: ${snapshot.incrementalSavings.estimatedTokensSaved.toLocaleString()}`);

        console.log(`\n📅 Since: ${new Date(snapshot.startedAt).toLocaleString()}`);
        console.log(`🔄 Last update: ${new Date(snapshot.lastUpdatedAt).toLocaleString()}`);
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
    });

  await program.parseAsync();
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

// Only run CLI when this file is executed directly (not imported)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
