import { describe, it, expect } from 'vitest';
import { KnowledgeGraphBuilder } from '../src/core/knowledge-graph.js';
import {
  recordFindingsAsFaults,
  recordPlanAsFixes,
  recordPatterns,
} from '../src/core/graph-writer.js';
import type { Finding, SolutionPlan, FaultPattern, FixPattern } from '../src/core/types.js';

function sampleGraph(): KnowledgeGraphBuilder {
  const builder = new KnowledgeGraphBuilder();
  builder.addNode({ id: 'file:src/utils.ts', type: 'file', name: 'utils.ts', filePath: 'src/utils.ts' });
  builder.addNode({ id: 'function:src/utils.ts:helper', type: 'function', name: 'helper', filePath: 'src/utils.ts' });
  builder.addNode({ id: 'file:src/index.ts', type: 'file', name: 'index.ts', filePath: 'src/index.ts' });
  return builder;
}

describe('recordFindingsAsFaults', () => {
  it('creates fault nodes and relates_to_fault edges for existing nodes', () => {
    const builder = sampleGraph();
    const findings: Finding[] = [
      {
        id: 'f-1',
        type: 'fault',
        description: 'Potential null dereference in helper',
        confidence: 0.8,
        nodeIds: ['function:src/utils.ts:helper'],
      },
    ];

    recordFindingsAsFaults(builder, findings);

    const graph = builder.build();
    expect(graph.nodes.some(n => n.id === 'fault:f-1' && n.type === 'fault')).toBe(true);
    expect(graph.edges.some(e => e.source === 'function:src/utils.ts:helper' && e.target === 'fault:f-1' && e.type === 'relates_to_fault')).toBe(true);
  });

  it('maps plain file paths to file node ids', () => {
    const builder = sampleGraph();
    const findings: Finding[] = [
      {
        id: 'f-2',
        type: 'style',
        description: 'Console log in index',
        confidence: 0.6,
        nodeIds: ['src/index.ts'],
      },
    ];

    recordFindingsAsFaults(builder, findings);

    const graph = builder.build();
    expect(graph.nodes.some(n => n.id === 'fault:f-2')).toBe(true);
    expect(graph.edges.some(e => e.source === 'file:src/index.ts' && e.target === 'fault:f-2' && e.type === 'relates_to_fault')).toBe(true);
  });

  it('skips dangling node references', () => {
    const builder = sampleGraph();
    const findings: Finding[] = [
      {
        id: 'f-3',
        type: 'fault',
        description: 'Unknown issue',
        confidence: 0.5,
        nodeIds: ['file:does-not-exist.ts'],
      },
    ];

    recordFindingsAsFaults(builder, findings);

    const graph = builder.build();
    expect(graph.nodes.some(n => n.id === 'fault:f-3')).toBe(true);
    expect(graph.edges).toHaveLength(0);
  });

  it('treats insight findings as low-severity faults', () => {
    const builder = sampleGraph();
    const findings: Finding[] = [
      {
        id: 'f-4',
        type: 'insight',
        description: 'Could be faster',
        confidence: 0.4,
        nodeIds: ['function:src/utils.ts:helper'],
      },
    ];

    recordFindingsAsFaults(builder, findings);

    const graph = builder.build();
    const fault = graph.nodes.find(n => n.id === 'fault:f-4');
    expect(fault).toBeDefined();
    expect(fault?.metadata?.severity).toBe('info');
    expect(graph.edges.some(e => e.source === 'function:src/utils.ts:helper' && e.target === 'fault:f-4' && e.type === 'relates_to_fault')).toBe(true);
  });

  it('is idempotent across multiple calls', () => {
    const builder = sampleGraph();
    const findings: Finding[] = [
      {
        id: 'f-5',
        type: 'fault',
        description: 'Duplicate',
        confidence: 0.7,
        nodeIds: ['file:src/index.ts'],
      },
    ];

    recordFindingsAsFaults(builder, findings);
    recordFindingsAsFaults(builder, findings);

    const graph = builder.build();
    expect(graph.nodes.filter(n => n.type === 'fault')).toHaveLength(1);
    expect(graph.edges.filter(e => e.type === 'relates_to_fault')).toHaveLength(1);
  });
});

describe('recordPlanAsFixes', () => {
  it('creates fix nodes and fixes edges', () => {
    const builder = sampleGraph();
    const plan: SolutionPlan = {
      id: 'plan-1',
      timestamp: new Date().toISOString(),
      taskId: 'task-1',
      problem: { description: 'Fix null', rootCause: 'Missing check', severity: 'major' },
      changes: [
        {
          filePath: 'src/utils.ts',
          changeType: 'modify',
          description: 'Add optional chaining',
          reasoning: 'Avoid null dereference',
        },
      ],
      metadata: { confidence: 0.9, tokenUsed: 100 },
    };

    recordPlanAsFixes(builder, plan);

    const graph = builder.build();
    expect(graph.nodes.some(n => n.id === 'fix:plan-1:0' && n.type === 'fix')).toBe(true);
    expect(graph.edges.some(e => e.source === 'fix:plan-1:0' && e.target === 'file:src/utils.ts' && e.type === 'fixes')).toBe(true);
  });

  it('creates mitigates edges when related findings are provided', () => {
    const builder = sampleGraph();
    const findings: Finding[] = [
      {
        id: 'f-null',
        type: 'fault',
        description: 'Null issue',
        confidence: 0.8,
        nodeIds: ['file:src/utils.ts'],
      },
    ];
    recordFindingsAsFaults(builder, findings);

    const plan: SolutionPlan = {
      id: 'plan-2',
      timestamp: new Date().toISOString(),
      taskId: 'task-2',
      problem: { description: 'Fix null', rootCause: 'Missing check', severity: 'major' },
      changes: [
        {
          filePath: 'src/utils.ts',
          changeType: 'modify',
          description: 'Add optional chaining',
          reasoning: 'Avoid null dereference',
        },
      ],
      metadata: { confidence: 0.9, tokenUsed: 100 },
    };

    recordPlanAsFixes(builder, plan, findings);

    const graph = builder.build();
    expect(graph.edges.some(e => e.source === 'fix:plan-2:0' && e.target === 'fault:f-null' && e.type === 'mitigates')).toBe(true);
  });

  it('skips changes whose file node does not exist', () => {
    const builder = sampleGraph();
    const plan: SolutionPlan = {
      id: 'plan-3',
      timestamp: new Date().toISOString(),
      taskId: 'task-3',
      problem: { description: 'Fix', rootCause: 'X', severity: 'minor' },
      changes: [
        {
          filePath: 'missing.ts',
          changeType: 'modify',
          description: 'Update',
          reasoning: 'Reason',
        },
      ],
      metadata: { confidence: 0.5, tokenUsed: 10 },
    };

    recordPlanAsFixes(builder, plan);

    const graph = builder.build();
    expect(graph.nodes.some(n => n.type === 'fix')).toBe(false);
  });
});

describe('recordPatterns', () => {
  it('creates pattern nodes and learned_from edges', () => {
    const builder = sampleGraph();
    const faultPatterns: FaultPattern[] = [
      { id: 'p1', pattern: 'Null safety issue', language: 'typescript', frequency: 2 },
    ];
    const fixPatterns: FixPattern[] = [
      { id: 'p2', pattern: 'Add optional chaining', language: 'typescript', frequency: 1 },
    ];

    recordPatterns(builder, faultPatterns, fixPatterns, ['file:src/utils.ts']);

    const graph = builder.build();
    expect(graph.nodes.some(n => n.id === 'pattern:fault:p1' && n.type === 'pattern')).toBe(true);
    expect(graph.nodes.some(n => n.id === 'pattern:fix:p2' && n.type === 'pattern')).toBe(true);
    expect(graph.edges.some(e => e.source === 'pattern:fault:p1' && e.target === 'file:src/utils.ts' && e.type === 'learned_from')).toBe(true);
    expect(graph.edges.some(e => e.source === 'pattern:fix:p2' && e.target === 'file:src/utils.ts' && e.type === 'learned_from')).toBe(true);
  });

  it('is idempotent', () => {
    const builder = sampleGraph();
    const faultPatterns: FaultPattern[] = [{ id: 'p3', pattern: 'X', frequency: 1 }];

    recordPatterns(builder, faultPatterns, [], ['file:src/utils.ts']);
    recordPatterns(builder, faultPatterns, [], ['file:src/utils.ts']);

    const graph = builder.build();
    expect(graph.nodes.filter(n => n.type === 'pattern')).toHaveLength(1);
    expect(graph.edges.filter(e => e.type === 'learned_from')).toHaveLength(1);
  });
});
