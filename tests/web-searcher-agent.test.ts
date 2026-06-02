import { describe, it, expect } from 'vitest';
import { WebSearcherAgent } from '../src/agents/web-searcher-agent.js';
import { MemoryMiddleware } from '../src/core/memory.js';
import type { AgentInput, Finding } from '../src/core/types.js';

describe('WebSearcherAgent', () => {
  it('returns search results for low-confidence findings', async () => {
    const memory = new MemoryMiddleware();
    const agent = new WebSearcherAgent(memory);

    const input: AgentInput = {
      taskId: 'test-search',
      instruction: 'Search for solutions',
      context: {
        findings: [
          {
            id: 'f1',
            type: 'fault',
            description: "Cannot read property 'map' of undefined",
            confidence: 0.3,
            nodeIds: ['node1'],
          },
        ] as Finding[],
        language: 'javascript',
        framework: 'react',
      },
    };

    const output = await agent.run(input);
    expect(output.findings.length).toBeGreaterThan(0);
    expect(output.result.searchResults).toBeDefined();
    expect(Array.isArray(output.result.searchResults)).toBe(true);
  });

  it('skips search when findings have high confidence', async () => {
    const memory = new MemoryMiddleware();
    const agent = new WebSearcherAgent(memory);

    const input: AgentInput = {
      taskId: 'test-search',
      instruction: 'Search for solutions',
      context: {
        findings: [
          {
            id: 'f1',
            type: 'fault',
            description: 'Minor style issue',
            confidence: 0.9,
            nodeIds: ['node1'],
          },
        ] as Finding[],
      },
    };

    const output = await agent.run(input);
    expect(output.result.searchResults).toEqual([]);
    expect(output.result.skipped).toBe(true);
  });

  it('skips search when no findings', async () => {
    const memory = new MemoryMiddleware();
    const agent = new WebSearcherAgent(memory);

    const input: AgentInput = {
      taskId: 'test-search',
      instruction: 'Search for solutions',
      context: {
        findings: [],
      },
    };

    const output = await agent.run(input);
    expect(output.result.searchResults).toEqual([]);
    expect(output.result.skipped).toBe(true);
  });
});