import { describe, it, expect } from 'vitest';
import { BaseAgent } from '../src/agents/base-agent.js';
import type { AgentInput, AgentOutput, Finding } from '../src/core/types.js';

class TestAgent extends BaseAgent {
  constructor() {
    super('test-agent');
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    return { message: `Processed: ${input.instruction}` };
  }
}

describe('BaseAgent', () => {
  it('has correct name', () => {
    const agent = new TestAgent();
    expect(agent.name).toBe('test-agent');
  });

  it('runs and returns output', async () => {
    const agent = new TestAgent();
    const input: AgentInput = {
      taskId: 'task-1',
      instruction: 'test instruction',
      context: {},
    };
    const output = await agent.run(input);
    expect(output.agentName).toBe('test-agent');
    expect(output.taskId).toBe('task-1');
    expect(output.result.message).toBe('Processed: test instruction');
    expect(output.findings).toHaveLength(0);
  });

  it('tracks execution time', async () => {
    const agent = new TestAgent();
    const input: AgentInput = {
      taskId: 'task-1',
      instruction: 'test',
      context: {},
    };
    const output = await agent.run(input);
    expect(output.result._meta).toBeDefined();
    expect(typeof (output.result._meta as Record<string, unknown>).durationMs).toBe('number');
  });
});
