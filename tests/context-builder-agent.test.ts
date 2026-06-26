import { describe, it, expect } from 'vitest';
import { ContextBuilderAgent } from '../src/agents/context-builder-agent.js';
import { MemoryMiddleware } from '../src/core/memory.js';
import { buildGraphFromFingerprints } from '../src/core/graph-build.js';
import type { FileFingerprint } from '../src/core/types.js';

function fp(partial: Partial<FileFingerprint> & { filePath: string }): FileFingerprint {
  return {
    contentHash: 'h', functions: [], classes: [], imports: [], exports: [],
    totalLines: 1, hasStructuralAnalysis: true, ...partial,
  };
}

/** Graph: foo --calls--> bar --calls--> baz (a call chain in one file). */
function chainMemory(): MemoryMiddleware {
  const graph = buildGraphFromFingerprints({
    'a.ts': fp({
      filePath: 'a.ts',
      functions: [
        { name: 'foo', params: [], isExported: true, startLine: 1, endLine: 2, calls: ['bar'] },
        { name: 'bar', params: [], isExported: false, startLine: 3, endLine: 4, calls: ['baz'] },
        { name: 'baz', params: [], isExported: false, startLine: 5, endLine: 6 },
      ],
    }),
  });
  const mem = new MemoryMiddleware();
  mem.setKnowledgeGraph(graph);
  return mem;
}

describe('ContextBuilderAgent', () => {
  it('returns a propagationResult with affectedNodes and rootCauseCandidates', async () => {
    const agent = new ContextBuilderAgent(chainMemory());
    const output = await agent.run({
      taskId: 't1',
      instruction: 'build context',
      context: { nodeIds: ['function:a.ts:foo'] },
    });

    const prop = output.result.propagationResult as {
      affectedNodes: Array<{ nodeId: string }>;
      rootCauseCandidates: Array<{ nodeId: string }>;
    };
    expect(prop).toBeDefined();
    const affectedIds = prop.affectedNodes.map(n => n.nodeId);
    expect(affectedIds).toContain('function:a.ts:bar');
    expect(affectedIds).toContain('function:a.ts:baz');
    expect(Array.isArray(prop.rootCauseCandidates)).toBe(true);
  });

  it('honors maxPropagationDepth, limiting how far propagation traverses', async () => {
    const agent = new ContextBuilderAgent(chainMemory());
    const output = await agent.run({
      taskId: 't2',
      instruction: 'build context',
      context: { nodeIds: ['function:a.ts:foo'], maxPropagationDepth: 1 },
    });

    const prop = output.result.propagationResult as { affectedNodes: Array<{ nodeId: string }> };
    const affectedIds = prop.affectedNodes.map(n => n.nodeId);
    expect(affectedIds).toContain('function:a.ts:bar'); // depth 1
    expect(affectedIds).not.toContain('function:a.ts:baz'); // depth 2 — beyond limit
  });

  it('accepts maxPropagationDepth of 0 (severe budget degradation) without traversing', async () => {
    const agent = new ContextBuilderAgent(chainMemory());
    const output = await agent.run({
      taskId: 't3',
      instruction: 'build context',
      context: { nodeIds: ['function:a.ts:foo'], maxPropagationDepth: 0 },
    });

    const prop = output.result.propagationResult as { affectedNodes: Array<{ nodeId: string }> };
    expect(prop.affectedNodes).toHaveLength(0);
  });

  it('keeps downstream callees in recall but excludes them from root-cause candidates', async () => {
    // Graph: caller --calls--> entry --calls--> callee
    // Entry is the symptom site. The callee is reachable downstream (useful as
    // context) but is NOT an upstream cause of the entry's fault, so it must not
    // appear among root-cause candidates.
    const graph = buildGraphFromFingerprints({
      'x.ts': fp({
        filePath: 'x.ts',
        functions: [
          { name: 'caller', params: [], isExported: true, startLine: 1, endLine: 2, calls: ['entry'] },
          { name: 'entry', params: [], isExported: false, startLine: 3, endLine: 4, calls: ['callee'] },
          { name: 'callee', params: [], isExported: false, startLine: 5, endLine: 6 },
        ],
      }),
    });
    const mem = new MemoryMiddleware();
    mem.setKnowledgeGraph(graph);

    const agent = new ContextBuilderAgent(mem);
    const output = await agent.run({
      taskId: 't4',
      instruction: 'build context',
      context: { nodeIds: ['function:x.ts:entry'] },
    });

    // Recall (both directions) still surfaces the downstream callee as context.
    const recalledIds = (output.result.nodes as Array<{ id: string }>).map(n => n.id);
    expect(recalledIds).toContain('function:x.ts:callee');

    // Root-cause candidates (upstream only) include the caller, never the callee.
    const prop = output.result.propagationResult as {
      rootCauseCandidates: Array<{ nodeId: string }>;
    };
    const rootCauseIds = prop.rootCauseCandidates.map(c => c.nodeId);
    expect(rootCauseIds).toContain('function:x.ts:caller');
    expect(rootCauseIds).not.toContain('function:x.ts:callee');
  });
});
