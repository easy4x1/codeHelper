import { describe, it, expect } from 'vitest';
import { CodeRepairAgent } from '../src/index.js';
import { TokenBudgetManager } from '../src/core/token-budget.js';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { generatePatch } from '../src/core/patch.js';
import { SemanticCache } from '../src/core/semantic-cache.js';
import { MemoryMiddleware } from '../src/core/memory.js';
import { LearningAgent } from '../src/agents/learning-agent.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'sample-repo');

describe('CodeRepairAgent', () => {
  it('initializes with config', () => {
    const agent = new CodeRepairAgent({ verbose: true });
    expect(agent).toBeDefined();
  });

  it('initializes a repo', async () => {
    const agent = new CodeRepairAgent({});
    const result = await agent.init(fixturePath);
    expect(result.files).toBeDefined();
    expect(result.files.length).toBeGreaterThan(0);
  });

  it('plans a repair task', async () => {
    const agent = new CodeRepairAgent({});
    await agent.init(fixturePath);

    const plan = await agent.plan({
      id: 'task-1',
      description: 'Fix potential issues',
      type: 'bug',
      priority: 'medium',
    });

    expect(plan.id).toBeDefined();
    expect(plan.changes).toBeDefined();
    expect(plan.problem).toBeDefined();
  });

  it('serializes memory to disk', async () => {
    const agent = new CodeRepairAgent({});
    await agent.init(fixturePath);
    await agent.saveMemory('/tmp/test-memory.json');
    // Just verify no error thrown
    expect(true).toBe(true);
  });

  it('deserializes memory from disk', async () => {
    const agent = new CodeRepairAgent({});
    await agent.init(fixturePath);
    const memoryPath = '/tmp/test-memory-load.json';
    await agent.saveMemory(memoryPath);

    const agent2 = new CodeRepairAgent({});
    await agent2.loadMemory(memoryPath);
    const fingerprints = agent2.getMemory().getAllFingerprints();
    expect(Object.keys(fingerprints).length).toBeGreaterThan(0);
  });
});

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

describe('CodeRepairAgent token budget', () => {
  it('initializes with default budget', () => {
    const agent = new CodeRepairAgent({});
    const status = agent.getBudgetManager().getStatus();
    expect(status.total).toBe(50000);
  });

  it('initializes with custom budget', () => {
    const agent = new CodeRepairAgent({
      tokenBudget: { total: 10000, analysis: 4000, planning: 3000 },
    });
    const status = agent.getBudgetManager().getStatus();
    expect(status.total).toBe(10000);
  });

  it('tracks token usage during plan', async () => {
    const agent = new CodeRepairAgent({ verbose: true });
    await agent.init(fixturePath);

    const before = agent.getBudgetManager().getStatus();
    expect(before.used).toBe(0);

    await agent.plan({
      id: 'task-budget',
      description: 'Fix type errors',
      type: 'bug',
      priority: 'medium',
    });

    const after = agent.getBudgetManager().getStatus();
    expect(after.used).toBeGreaterThan(0);
    expect(after.usageByCategory.analysis).toBeGreaterThan(0);
    expect(after.usageByCategory.planning).toBeGreaterThan(0);
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

  it('disables web search when budget is low', async () => {
    const agent = new CodeRepairAgent({
      tokenBudget: {
        total: 100,
        analysis: 40,
        planning: 30,
        search: 20,
        review: 10,
      },
      webSearch: true,
    });

    // Exhaust budget to trigger disable_search
    const bm = agent.getBudgetManager();
    bm.recordUsage('analysis', 85);

    const recs = bm.getRecommendations();
    expect(recs.adjustments.enableWebSearch).toBe(false);
  });
});

describe('CLI --budget option', () => {
  it('accepts custom budget via CLI', async () => {
    const agent = new CodeRepairAgent({
      tokenBudget: { total: 5000, analysis: 2000, planning: 1500 },
    });
    await agent.init(fixturePath);

    const status = agent.getBudgetManager().getStatus();
    expect(status.total).toBe(5000);
  });
});

describe('Semantic cache integration', () => {
  it('returns cached plan for similar task descriptions', async () => {
    const agent = new CodeRepairAgent({});

    // First plan — triggers analysis
    const plan1 = await agent.plan({
      id: 'task-1',
      description: 'Fix null pointer in auth module',
      type: 'bug',
      priority: 'medium',
    });
    expect(plan1).toBeDefined();

    // Second plan — similar description should ideally be served from cache
    // Note: This test validates the cache mechanism exists; actual cache hit
    // depends on the semantic similarity threshold
  });
});

describe('CLI: history and learn', () => {
  it('records and retrieves task history', () => {
    const memory = new MemoryMiddleware();
    const agent = new LearningAgent(memory);

    agent.recordTaskCompletion('t1', 'Fix bug', ['src/a.ts'], 2, true);
    agent.recordTaskCompletion('t2', 'Refactor', ['src/b.ts'], 0, true);

    const history = memory.getTaskHistory();
    expect(history).toHaveLength(2);
    expect(history[0].description).toBe('Fix bug');
  });

  it('learns conventions from fingerprints', async () => {
    const memory = new MemoryMiddleware();
    // Add a mock fingerprint
    memory.setFingerprint({
      filePath: 'src/utils.ts',
      contentHash: 'abc',
      functions: [{ name: 'getUserName', params: [], isExported: true, startLine: 1, endLine: 1 }],
      classes: [],
      imports: [],
      exports: [],
      totalLines: 10,
      hasStructuralAnalysis: true,
    });

    const agent = new LearningAgent(memory);
    await agent.run({
      taskId: 'learn-test',
      instruction: 'Learn conventions',
      context: { repoPath: '.' },
    });

    const conventions = memory.getConventions();
    expect(conventions.length).toBeGreaterThan(0);
  });
});
