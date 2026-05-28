import { describe, it, expect } from 'vitest';
import { RepoScannerAgent } from '../src/agents/repo-scanner-agent.js';
import { FaultDetectorAgent } from '../src/agents/fault-detector-agent.js';
import { ContextBuilderAgent } from '../src/agents/context-builder-agent.js';
import { SolutionPlannerAgent } from '../src/agents/solution-planner-agent.js';
import { MemoryMiddleware } from '../src/core/memory.js';
import type { AgentInput, KnowledgeGraph, GraphNode } from '../src/core/types.js';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'sample-repo');

describe('RepoScannerAgent', () => {
  it('scans repo and stores in memory', async () => {
    const memory = new MemoryMiddleware();
    const agent = new RepoScannerAgent(memory);
    const input: AgentInput = {
      taskId: 'task-1',
      instruction: 'Scan the repository',
      context: { repoPath: fixturePath },
    };
    const output = await agent.run(input);
    expect(output.result.files).toBeDefined();
    expect(Array.isArray(output.result.files)).toBe(true);
    expect(memory.getRepoMemory().fingerprints).toBeDefined();
  });
});

describe('FaultDetectorAgent', () => {
  it('detects faults in code', async () => {
    const memory = new MemoryMiddleware();
    const graph: KnowledgeGraph = {
      nodes: [
        { id: 'file:src/index.ts', type: 'file', name: 'index.ts' },
        { id: 'function:src/index.ts:main', type: 'function', name: 'main' },
      ],
      edges: [],
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    };
    memory.setKnowledgeGraph(graph);

    const agent = new FaultDetectorAgent(memory);
    const input: AgentInput = {
      taskId: 'task-1',
      instruction: 'Find issues',
      context: { targetFiles: ['src/index.ts'] },
    };
    const output = await agent.run(input);
    expect(output.findings).toBeDefined();
    expect(Array.isArray(output.findings)).toBe(true);
  });
});

describe('ContextBuilderAgent', () => {
  it('builds context for target nodes', async () => {
    const memory = new MemoryMiddleware();
    const graph: KnowledgeGraph = {
      nodes: [
        { id: 'file:src/index.ts', type: 'file', name: 'index.ts' },
        { id: 'function:src/index.ts:main', type: 'function', name: 'main' },
      ],
      edges: [
        { id: 'e1', source: 'file:src/index.ts', target: 'function:src/index.ts:main', type: 'contains', weight: 1.0 },
      ],
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    };
    memory.setKnowledgeGraph(graph);

    const agent = new ContextBuilderAgent(memory);
    const input: AgentInput = {
      taskId: 'task-1',
      instruction: 'Build context',
      context: { nodeIds: ['function:src/index.ts:main'] },
    };
    const output = await agent.run(input);
    expect(output.result.nodes).toBeDefined();
    expect(Array.isArray(output.result.nodes)).toBe(true);
  });
});

describe('SolutionPlannerAgent', () => {
  it('generates a solution plan', async () => {
    const memory = new MemoryMiddleware();
    const agent = new SolutionPlannerAgent(memory);
    const input: AgentInput = {
      taskId: 'task-1',
      instruction: 'Fix the bug',
      context: {
        problem: 'Null pointer exception in main()',
        affectedFiles: ['src/index.ts'],
        findings: [
          { id: 'f1', type: 'fault', description: 'Missing null check', confidence: 0.9, nodeIds: ['function:src/index.ts:main'] },
        ],
      },
    };
    const output = await agent.run(input);
    expect(output.result.plan).toBeDefined();
    expect(output.result.plan).toHaveProperty('id');
    expect(output.result.plan).toHaveProperty('changes');
  });
});
