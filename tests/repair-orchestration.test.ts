import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CodeRepairAgent } from '../src/index.js';
import type { SolutionPlan } from '../src/core/types.js';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

function makePlan(filePath: string, original: string, modified: string): SolutionPlan {
  return {
    id: 'plan-test',
    timestamp: new Date().toISOString(),
    taskId: 'task-test',
    problem: { description: 'test problem', rootCause: 'test cause', severity: 'medium' },
    changes: [
      {
        filePath,
        changeType: 'modify',
        description: 'update content',
        reasoning: 'because test',
        originalCode: original,
        modifiedCode: modified,
      },
    ],
    metadata: { confidence: 0.8, tokenUsed: 0 },
  };
}

describe('CodeRepairAgent.applyPlan', () => {
  let dir: string;
  let target: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'repair-orch-'));
    target = join(dir, 'sample.txt');
    await writeFile(target, 'ORIGINAL', 'utf-8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('applies patches to disk when approved by default (push disabled)', async () => {
    const agent = new CodeRepairAgent({ provider: 'template' });
    const outcome = await agent.applyPlan(makePlan(target, 'ORIGINAL', 'CHANGED'), { push: false });

    expect(outcome.approved).toBe(true);
    expect(outcome.applied).toContain(target);
    expect(outcome.failed).toHaveLength(0);
    expect(await readFile(target, 'utf-8')).toBe('CHANGED');
    expect(outcome.git).toBeUndefined();
  });

  it('dry run generates patches but does not touch disk', async () => {
    const agent = new CodeRepairAgent({ provider: 'template' });
    const outcome = await agent.applyPlan(makePlan(target, 'ORIGINAL', 'CHANGED'), {
      dryRun: true,
      push: false,
    });

    expect(outcome.patches).toHaveLength(1);
    expect(outcome.approved).toBe(false);
    expect(outcome.applied).toHaveLength(0);
    expect(await readFile(target, 'utf-8')).toBe('ORIGINAL');
  });

  it('aborts without writing when review gate returns false', async () => {
    const agent = new CodeRepairAgent({ provider: 'template' });
    const outcome = await agent.applyPlan(makePlan(target, 'ORIGINAL', 'CHANGED'), {
      push: false,
      review: async () => false,
    });

    expect(outcome.approved).toBe(false);
    expect(outcome.applied).toHaveLength(0);
    expect(await readFile(target, 'utf-8')).toBe('ORIGINAL');
  });

  it('passes plan, patches and summary to the review gate', async () => {
    const agent = new CodeRepairAgent({ provider: 'template' });
    let seen: { patches: number; planId: string } | undefined;
    await agent.applyPlan(makePlan(target, 'ORIGINAL', 'CHANGED'), {
      push: false,
      review: async (ctx) => {
        seen = { patches: ctx.patches.length, planId: ctx.plan.id };
        return true;
      },
    });

    expect(seen).toEqual({ patches: 1, planId: 'plan-test' });
  });

  it('records the completed task into learned memory by default', async () => {
    const agent = new CodeRepairAgent({ provider: 'template' });
    expect(agent.getMemory().getTaskHistory()).toHaveLength(0);

    await agent.applyPlan(makePlan(target, 'ORIGINAL', 'CHANGED'), { push: false });

    const history = agent.getMemory().getTaskHistory();
    expect(history).toHaveLength(1);
    expect(history[0].taskId).toBe('task-test');
    expect(history[0].success).toBe(true);
  });

  it('skips learned-memory recording when record is false', async () => {
    const agent = new CodeRepairAgent({ provider: 'template' });
    await agent.applyPlan(makePlan(target, 'ORIGINAL', 'CHANGED'), { push: false, record: false });

    expect(agent.getMemory().getTaskHistory()).toHaveLength(0);
  });
});

describe('CodeRepairAgent.apply', () => {
  it('throws when the plan id cannot be found', async () => {
    const agent = new CodeRepairAgent({ provider: 'template' });
    const dir = await mkdtemp(join(tmpdir(), 'repair-apply-'));
    await expect(agent.apply('missing-plan', dir, { push: false })).rejects.toThrow('Plan not found');
    await rm(dir, { recursive: true, force: true });
  });
});
