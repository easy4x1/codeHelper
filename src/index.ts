#!/usr/bin/env node

import { Command } from 'commander';
import { MemoryMiddleware } from './core/memory.js';
import { RepoScannerAgent } from './agents/repo-scanner-agent.js';
import { FaultDetectorAgent } from './agents/fault-detector-agent.js';
import { ContextBuilderAgent } from './agents/context-builder-agent.js';
import { SolutionPlannerAgent } from './agents/solution-planner-agent.js';
import { KnowledgeGraphBuilder } from './core/knowledge-graph.js';
import { writeFile, readFile, access, mkdir } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import type { RepairTask, SolutionPlan } from './core/types.js';

export interface AgentConfig {
  verbose?: boolean;
  memoryPath?: string;
}

export class CodeRepairAgent {
  private memory: MemoryMiddleware;
  private config: AgentConfig;

  constructor(config: AgentConfig = {}) {
    this.config = config;
    this.memory = new MemoryMiddleware();
  }

  async init(repoPath: string): Promise<{ files: string[]; fingerprintCount: number }> {
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
    const detector = new FaultDetectorAgent(this.memory);
    const detectorResult = await detector.run({
      taskId: task.id,
      instruction: task.description,
      context: { targetFiles: task.context?.files || [] },
    });

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

    const planner = new SolutionPlannerAgent(this.memory);
    const plannerResult = await planner.run({
      taskId: task.id,
      instruction: task.description,
      context: {
        problem: task.description,
        findings,
        affectedFiles: task.context?.files || [],
      },
    });

    return plannerResult.result.plan as SolutionPlan;
  }

  async saveMemory(path: string): Promise<void> {
    const serialized = this.memory.serialize();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serialized, 'utf-8');
  }

  async loadMemory(path: string): Promise<void> {
    try {
      await access(path);
      const data = await readFile(path, 'utf-8');
      this.memory = MemoryMiddleware.deserialize(data);
    } catch {
      // File doesn't exist, use fresh memory
    }
  }

  getMemory(): MemoryMiddleware {
    return this.memory;
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
      const agent = new CodeRepairAgent({ verbose: true });
      const result = await agent.init(repoPath);
      await agent.saveMemory(join(resolve(repoPath), '.repair-agent', 'memory.json'));
      console.log(`Initialized: ${result.fingerprintCount} files scanned`);
    });

  program
    .command('plan')
    .description('Generate a repair plan')
    .argument('<description>', 'Problem description')
    .option('-r, --repo <path>', 'Repository path', '.')
    .option('--file <file>', 'Target file(s)', collect, [])
    .action(async (description: string, options: { repo: string; file: string[] }) => {
      const agent = new CodeRepairAgent({ verbose: true });
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
    });

  program
    .command('status')
    .description('Show knowledge graph status')
    .argument('[repo-path]', 'Path to repository', '.')
    .action(async (repoPath: string) => {
      const agent = new CodeRepairAgent({});
      const memoryPath = join(resolve(repoPath), '.repair-agent', 'memory.json');
      await agent.loadMemory(memoryPath);
      const memory = agent.getMemory();
      const graph = memory.getKnowledgeGraph();
      const fingerprints = memory.getAllFingerprints();
      console.log(`Nodes: ${graph.nodes.length}`);
      console.log(`Edges: ${graph.edges.length}`);
      console.log(`Fingerprints: ${Object.keys(fingerprints).length}`);
    });

  await program.parseAsync();
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

// Only run CLI when this file is executed directly (not imported)
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1])) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
