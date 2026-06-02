#!/usr/bin/env node

import { Command } from 'commander';
import { MemoryMiddleware } from './core/memory.js';
import { RepoScannerAgent } from './agents/repo-scanner-agent.js';
import { buildImportMap } from './core/repo-scanner.js';
import { FaultDetectorAgent } from './agents/fault-detector-agent.js';
import { ContextBuilderAgent } from './agents/context-builder-agent.js';
import { SolutionPlannerAgent } from './agents/solution-planner-agent.js';
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
import { AnthropicLlmService, TemplateLlmService, type LlmService } from './core/llm-service.js';
import { TokenBudgetManager } from './core/token-budget.js';

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
        : undefined
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

    const planningTokens = TokenBudgetManager.estimateTokens(JSON.stringify(plannerResult.result));
    this.budgetManager.recordUsage('planning', planningTokens);

    const degradation = this.budgetManager.checkDegradation();
    if (degradation.level !== 'none') {
      this.logger.warn(`Token budget degradation: ${degradation.level} — ${degradation.message}`);
    }

    return plannerResult.result.plan as SolutionPlan;
  }

  async saveMemory(path: string): Promise<void> {
    const serialized = this.memory.serialize();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serialized, 'utf-8');
  }

  async loadMemory(path: string): Promise<void> {
    try {
      const data = await readFile(path, 'utf-8');
      this.memory = MemoryMiddleware.deserialize(data);
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
    .version('0.1.0');

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
    .option('--llm <provider>', 'LLM provider: anthropic | template', 'template')
    .option('--budget <tokens>', 'Total token budget', '50000')
    .action(async (description: string, options: { repo: string; file: string[]; llm: string; budget: string }) => {
      try {
        const llmService = options.llm === 'anthropic' ? 'anthropic' as const : 'template' as const;
        const total = parseInt(options.budget, 10);
        const agent = new CodeRepairAgent({
          verbose: true,
          llmService,
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
        console.log('\n=== Solution Plan ===\n');
        console.log(`ID: ${plan.id}`);
        console.log(`Problem: ${plan.problem.description}`);
        console.log(`Root Cause: ${plan.problem.rootCause}`);
        console.log(`\nChanges (${plan.changes.length}):`);
        for (const change of plan.changes) {
          console.log(`  - ${change.filePath}: ${change.description}`);
        }
        console.log(`\nConfidence: ${(plan.metadata.confidence * 100).toFixed(1)}%`);
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
    .option('--file <file>', 'Target file(s)', (val: string, prev: string[]) => prev.concat([val]), [])
    .option('--auto-push', 'Automatically apply without confirmation', false)
    .option('--llm <provider>', 'LLM provider: anthropic | template', 'template')
    .option('--budget <tokens>', 'Total token budget', '50000')
    .action(async (description: string, options: { repo: string; file: string[]; autoPush: boolean; llm: string; budget: string }) => {
      try {
        const llmService = options.llm === 'anthropic' ? 'anthropic' as const : 'template' as const;
        const total = parseInt(options.budget, 10);
        const agent = new CodeRepairAgent({
          verbose: true,
          llmService,
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
