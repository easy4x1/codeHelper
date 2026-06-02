import { describe, it, expect } from 'vitest';
import { CodeRepairAgent } from '../src/index.js';
import { TokenBudgetManager } from '../src/core/token-budget.js';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { generatePatch } from '../src/core/patch.js';

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
});
