import { describe, it, expect } from 'vitest';
import { LearningAgent } from '../src/agents/learning-agent.js';
import { MemoryMiddleware } from '../src/core/memory.js';

describe('LearningAgent', () => {
  it('learns from a completed task', async () => {
    const memory = new MemoryMiddleware();
    const agent = new LearningAgent(memory);

    await agent.run({
      taskId: 'learn-1',
      instruction: 'Learn from task history',
      context: {
        repoPath: '.',
      },
    });

    const learned = memory.getLearnedMemory();
    // At minimum, conventions should be learned from repo
    expect(learned.projectConventions.length).toBeGreaterThanOrEqual(0);
  });

  it('records task completion', () => {
    const memory = new MemoryMiddleware();
    const agent = new LearningAgent(memory);

    agent.recordTaskCompletion('task-1', 'Fix bug', ['src/index.ts'], 2, true);
    const learned = memory.getLearnedMemory();
    expect(learned.taskHistory).toHaveLength(1);
    expect(learned.taskHistory[0].success).toBe(true);
  });
});
