#!/usr/bin/env node

import { Command } from 'commander';
import { MemoryMiddleware } from './core/memory.js';
import { RepoScannerAgent } from './agents/repo-scanner-agent.js';
import { buildImportMap } from './core/repo-scanner.js';
import { FaultDetectorAgent } from './agents/fault-detector-agent.js';
import { ContextBuilderAgent } from './agents/context-builder-agent.js';
import { SolutionPlannerAgent } from './agents/solution-planner-agent.js';
import { WebSearcherAgent } from './agents/web-searcher-agent.js';
import { KnowledgeGraphBuilder } from './core/knowledge-graph.js';
import { writeFile, readFile, access, mkdir, stat } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { pathToFileURL } from 'url';
import { createLogger } from './utils/logger.js';
import type { RepairTask, SolutionPlan } from './core/types.js';
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

export interface AgentConfig {
  verbose?: boolean;
  memoryPath?: string;
  /** @deprecated Use `provider` instead */
  llmService?: 'anthropic' | 'template';
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

  constructor(config: AgentConfig = {}) {
    this.config = config;
    this.memory = new MemoryMiddleware();

    // Resolve LLM provider configuration securely
    const provider = config.provider ?? (config.llmService === 'anthropic' ? 'anthropic' : undefined);
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

    // Build a basic knowledge graph from fingerprints
    const builder = new KnowledgeGraphBuilder();
    const fingerprints = this.memory.getAllFingerprints();
    for (const [path, fp] of Object.entries(fingerprints)) {
      builder.addNode({ id: `file:${path}`, type: 'file', name: path.split('/').pop() || path, filePath: path });
      for (const fn of fp.functions) {
        builder.addNode({ id: `function:${path}:${fn.name}`, type: 'function', name: fn.name, filePath: path });
        builder.addEdge(`file:${path}`, `function:${path}:${fn.name}`, 'contains', 1.0);
      }
      for (const cls of fp.classes) {
        builder.addNode({ id: `class:${path}:${cls.name}`, type: 'class', name: cls.name, filePath: path });
        builder.addEdge(`file:${path}`, `class:${path}:${cls.name}`, 'contains', 1.0);
      }
      for (const imp of fp.imports) {
        builder.addEdge(`file:${path}`, `module:${imp.source}`, 'imports', 0.7);
      }
    }
    this.memory.setKnowledgeGraph(builder.build());

    const files = result.result.files as string[];
    return {
      files,
      fingerprintCount: files.length,
    };
  }

  async plan(task: RepairTask): Promise<SolutionPlan> {
    const recommendations = this.budgetManager.getRecommendations();
    if (!recommendations.shouldProceed) {
      throw new Error('Token budget exceeded: ' + recommendations.message);
    }

    const status = this.budgetManager.getStatus();
    this.logger.info(`Token budget: ${status.remaining} tokens remaining`);

    const detector = new FaultDetectorAgent(this.memory, this.llmService);
    const detectorResult = await detector.run({
      taskId: task.id,
      instruction: task.description,
      context: { targetFiles: task.context?.files || [] },
    });

    const findings = detectorResult.findings;

    const analysisTokens = TokenBudgetManager.estimateTokens(JSON.stringify(detectorResult.findings));
    this.budgetManager.recordUsage('analysis', analysisTokens);

    if (findings.length > 0) {
      const nodeIds = findings.flatMap(f => f.nodeIds);
      const builder = new ContextBuilderAgent(this.memory);
      await builder.run({
        taskId: task.id,
        instruction: 'Build context for findings',
        context: { nodeIds },
      });
    }

    // ---- Web Search (Phase 3) ----
    let searchResults: Array<{ title: string; url: string; snippet: string; credibilityScore: number }> = [];
    if (this.config.webSearch !== false && findings.length > 0) {
      const webSearcher = new WebSearcherAgent(this.memory);
      const searchOutput = await webSearcher.run({
        taskId: task.id,
        instruction: 'Search web for solutions',
        context: {
          findings,
          language: 'typescript',
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

    return plannerResult.result.plan as SolutionPlan;
  }

  async saveMemory(path: string): Promise<void> {
    // Sync token budget state into L2 for cross-session tracking
    this.memory.setTokenBudget(this.budgetManager.getStatus());
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
}

// CLI setup
async function main(): Promise<void> {
  const program = new Command();

  program
    .name('code-agent')
    .description('AI-powered code repair agent')
    .version('0.4.0');

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
    .option('--provider <name>', 'LLM provider: anthropic | openai | moonshot | deepseek | zhipu | template', 'template')
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

        // Generate patches from plan
        const patchGenerator = new PatchGeneratorAgent(agent.getMemory());
        const patchResult = await patchGenerator.run({
          taskId: plan.taskId,
          instruction: 'Generate patches for the plan',
          context: { plan },
        });

        const patches = patchResult.result.patches as FilePatch[];

        if (options.dryRun) {
          console.log('\n--- Dry Run (no changes applied) ---');
          for (const patch of patches) {
            console.log(formatDiff(patch));
          }
          return;
        }

        // Apply patches
        const result = await agent.applyPatches(patches);
        console.log(`\nApplied: ${result.applied.length} file(s)`);
        if (result.failed.length > 0) {
          console.log(`Failed: ${result.failed.join(', ')}`);
          process.exit(1);
        }

        // Git execution
        if (result.applied.length > 0) {
          const gitAgent = new GitExecutorAgent();
          const gitResult = await gitAgent.run({
            taskId: `git-${Date.now()}`,
            instruction: 'Commit and push changes',
            context: {
              files: result.applied,
              description: plan.problem.description,
            },
          });

          const gitOutput = gitResult.result as { success: boolean; messages?: string[]; errors?: string[] };
          if (gitOutput.success) {
            console.log('\n✅ Git workflow complete');
            for (const msg of gitOutput.messages || []) {
              console.log(`  → ${msg}`);
            }
          } else {
            console.log('\n⚠️ Git workflow failed');
            for (const err of gitOutput.errors || []) {
              console.log(`  ✗ ${err}`);
            }
            process.exit(1);
          }
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
    .option('--llm <provider>', 'LLM provider: anthropic | template', 'template')
    .option('--budget <tokens>', 'Total token budget', '50000')
    .option('--web-search', 'Enable web search for solutions', true)
    .option('--no-web-search', 'Disable web search for solutions')
    .action(async (description: string, options: { repo: string; file: string[]; autoPush: boolean; llm: string; budget: string; webSearch: boolean }) => {
      try {
        const llmService = options.llm === 'anthropic' ? 'anthropic' as const : 'template' as const;
        const total = parseInt(options.budget, 10);
        const agent = new CodeRepairAgent({
          verbose: true,
          llmService,
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
        let appliedFiles: string[] = [];

        if (options.autoPush) {
          console.log('Auto-applying (auto-push flag set)...');
          const result = await agent.applyPatches(patches);
          console.log(`Applied: ${result.applied.length}, Failed: ${result.failed.length}`);
          appliedFiles = result.applied;
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
            appliedFiles = result.applied;
          } else {
            console.log('Changes rejected. No files modified.');
          }
        }

        // Step 5: Git execution (Phase 4)
        if (appliedFiles.length > 0) {
          const gitAgent = new GitExecutorAgent();
          const gitResult = await gitAgent.run({
            taskId: `git-${Date.now()}`,
            instruction: 'Commit and push changes',
            context: {
              files: appliedFiles,
              description: task.description,
            },
          });

          const result = gitResult.result as { success: boolean; messages?: string[]; errors?: string[] };
          if (result.success) {
            console.log('\n✅ Git workflow complete');
            for (const msg of result.messages || []) {
              console.log(`  → ${msg}`);
            }
          } else {
            console.log('\n⚠️ Git workflow failed');
            for (const err of result.errors || []) {
              console.log(`  ✗ ${err}`);
            }
          }
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
    .option('--llm <provider>', 'LLM provider: anthropic | template', 'template')
    .option('--budget <tokens>', 'Total token budget per task', '50000')
    .option('--web-search', 'Enable web search', true)
    .option('--no-web-search', 'Disable web search')
    .option('--parallel', 'Run tasks in parallel (experimental)', false)
    .action(async (tasksFile: string, options: {
      repo: string;
      autoPush: boolean;
      llm: string;
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

        const llmService = options.llm === 'anthropic' ? 'anthropic' as const : 'template' as const;
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
              // Auto-apply: load plan → patch → apply → git
              const loadedPlan = await agent.loadPlan(plan.id, options.repo);
              if (!loadedPlan) {
                throw new Error(`Failed to load plan: ${plan.id}`);
              }

              const patchGenerator = new PatchGeneratorAgent(agent.getMemory());
              const patchResult = await patchGenerator.run({
                taskId,
                instruction: 'Generate patches',
                context: { plan: loadedPlan },
              });

              const patches = patchResult.result.patches as FilePatch[];
              const applyResult = await agent.applyPatches(patches);

              if (applyResult.applied.length > 0) {
                const gitAgent = new GitExecutorAgent();
                await gitAgent.run({
                  taskId: `git-${Date.now()}`,
                  instruction: 'Commit batch changes',
                  context: {
                    files: applyResult.applied,
                    description: taskDesc,
                  },
                });
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
