import { describe, it, expect } from 'vitest';
import { MemoryMiddleware } from '../src/core/memory.js';
import { RootCauseAnalyzerAgent } from '../src/agents/root-cause-analyzer-agent.js';
import { TemplateLlmService } from '../src/core/llm-service.js';

describe('RootCauseAnalyzerAgent', () => {
  const createAgent = () => {
    const memory = new MemoryMiddleware();
    const llm = new TemplateLlmService();
    return new RootCauseAnalyzerAgent(memory, llm);
  };

  it('analyzes root cause from findings', async () => {
    const agent = createAgent();
    const result = await agent.run({
      taskId: 'test-root-cause',
      instruction: 'Analyze root cause',
      context: {
        problem: 'Login API returns 500 error',
        findings: [
          {
            id: 'finding-1',
            type: 'fault',
            description: 'Potential null dereference in auth.ts',
            confidence: 0.8,
            nodeIds: ['file:src/auth.ts'],
          },
        ],
        codeContext: [],
        searchResults: [],
      },
    });

    expect(result.result.rootCause).toBeDefined();
    expect(result.result.severity).toMatch(/low|medium|high|critical/);
    expect(result.result.confidence).toBeGreaterThan(0);
    expect(Array.isArray(result.result.affectedFiles)).toBe(true);
  });

  it('incorporates search results into root cause', async () => {
    const agent = createAgent();
    const result = await agent.run({
      taskId: 'test-root-cause-search',
      instruction: 'Analyze root cause with search',
      context: {
        problem: 'Memory leak in React component',
        findings: [
          {
            id: 'finding-1',
            type: 'fault',
            description: 'useEffect missing cleanup function',
            confidence: 0.75,
            nodeIds: ['file:src/components/user-list.tsx'],
          },
        ],
        codeContext: [],
        searchResults: [
          {
            title: 'React useEffect memory leak fix',
            snippet: 'Return cleanup function from useEffect to prevent memory leaks',
            credibility: 0.9,
          },
        ],
      },
    });

    expect(result.result.rootCause).toContain('useEffect');
    expect(result.result.confidence).toBeGreaterThan(0.4);
  });

  it('handles empty findings gracefully', async () => {
    const agent = createAgent();
    const result = await agent.run({
      taskId: 'test-empty',
      instruction: 'Analyze root cause',
      context: {
        problem: 'Slow page load',
        findings: [],
        codeContext: [],
        searchResults: [],
      },
    });

    expect(result.result.rootCause).toContain('manual review');
    expect(result.result.severity).toBe('medium');
    expect(result.result.confidence).toBeLessThan(0.5);
  });

  it('returns propagation insights when provided', async () => {
    const agent = createAgent();
    const result = await agent.run({
      taskId: 'test-propagation',
      instruction: 'Analyze root cause',
      context: {
        problem: 'Cascade failure in API handlers',
        findings: [
          {
            id: 'finding-1',
            type: 'fault',
            description: 'Unhandled rejection in base handler',
            confidence: 0.9,
            nodeIds: ['function:src/api/base.ts:handleRequest'],
          },
        ],
        codeContext: [],
        searchResults: [],
        propagationResult: {
          affectedNodes: [
            { nodeId: 'function:src/api/users.ts:getUsers', nodeType: 'function', impactProbability: 0.85 },
          ],
          rootCauseCandidates: [
            { nodeId: 'function:src/api/base.ts:handleRequest', confidence: 0.95 },
          ],
        },
      },
    });

    expect(Array.isArray(result.result.propagationInsights)).toBe(true);
    expect(result.result.affectedFiles).toContain('src/api/users.ts');
  });
});
