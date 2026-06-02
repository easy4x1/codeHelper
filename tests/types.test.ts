import { describe, it, expect } from 'vitest';
import type {
  FileFingerprint,
  ChangeLevel,
  KnowledgeGraph,
  GraphNode,
  GraphEdge,
  PropagationOptions,
  AffectedNode,
  PropagationResult,
  TokenBudgetConfig,
  TokenBudgetStatus,
  DegradationLevel,
  BudgetRecommendations,
} from '../src/core/types.js';

describe('types', () => {
  it('FileFingerprint interface is usable', () => {
    const fp: FileFingerprint = {
      filePath: 'src/index.ts',
      contentHash: 'abc123',
      functions: [],
      classes: [],
      imports: [],
      exports: [],
      totalLines: 100,
      hasStructuralAnalysis: true,
    };
    expect(fp.filePath).toBe('src/index.ts');
  });

  it('ChangeLevel union works', () => {
    const levels: ChangeLevel[] = ['NONE', 'COSMETIC', 'STRUCTURAL', 'SEMANTIC'];
    expect(levels).toHaveLength(4);
  });

  it('KnowledgeGraph can be constructed', () => {
    const node: GraphNode = {
      id: 'file:src/index.ts',
      type: 'file',
      name: 'index.ts',
      filePath: 'src/index.ts',
    };
    const edge: GraphEdge = {
      id: 'edge-1',
      source: 'file:src/index.ts',
      target: 'function:src/index.ts:main',
      type: 'contains',
      weight: 1.0,
    };
    const graph: KnowledgeGraph = {
      nodes: [node],
      edges: [edge],
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    };
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(1);
  });

  it('PropagationOptions accepts valid values', () => {
    const opts: PropagationOptions = {
      direction: 'downstream',
      maxDepth: 3,
      minEdgeWeight: 0.5,
      includeTests: false,
    };
    expect(opts.direction).toBe('downstream');
    expect(opts.maxDepth).toBe(3);
  });

  it('AffectedNode accepts valid values', () => {
    const node: AffectedNode = {
      nodeId: 'node-1',
      nodeType: 'function',
      impactProbability: 0.8,
      distance: 2,
      path: ['node-0', 'node-1'],
    };
    expect(node.nodeType).toBe('function');
    expect(node.impactProbability).toBe(0.8);
  });

  it('PropagationResult accepts valid values', () => {
    const result: PropagationResult = {
      entryPoints: ['node-0'],
      affectedNodes: [
        {
          nodeId: 'node-1',
          nodeType: 'class',
          impactProbability: 0.9,
          distance: 1,
          path: ['node-0', 'node-1'],
        },
      ],
      rootCauseCandidates: [
        {
          nodeId: 'node-0',
          nodeType: 'file',
          confidence: 0.95,
          reasoning: 'Initial fault location',
        },
      ],
      propagationPaths: [
        {
          fromNodeId: 'node-0',
          toNodeId: 'node-1',
          edgeType: 'contains',
          weight: 1.0,
        },
      ],
    };
    expect(result.affectedNodes).toHaveLength(1);
    expect(result.rootCauseCandidates).toHaveLength(1);
    expect(result.propagationPaths).toHaveLength(1);
  });

  it('TokenBudgetConfig accepts valid values', () => {
    const config: TokenBudgetConfig = {
      total: 100000,
      allocated: {
        analysis: 30000,
        search: 20000,
        planning: 30000,
        review: 20000,
      },
    };
    expect(config.total).toBe(100000);
    expect(config.allocated.planning).toBe(30000);
  });

  it('TokenBudgetStatus accepts valid values', () => {
    const status: TokenBudgetStatus = {
      total: 100000,
      allocated: {
        analysis: 30000,
        search: 20000,
        planning: 30000,
        review: 20000,
      },
      used: 45000,
      remaining: 55000,
      usageByCategory: {
        analysis: 15000,
        search: 10000,
        planning: 15000,
        review: 5000,
      },
    };
    expect(status.used).toBe(45000);
    expect(status.remaining).toBe(55000);
  });

  it('all DegradationLevel values are valid', () => {
    const levels: DegradationLevel[] = [
      'none',
      'reduce_depth',
      'disable_search',
      'core_only',
      'prompt_user',
    ];
    expect(levels).toHaveLength(5);
  });

  it('BudgetRecommendations accepts valid values', () => {
    const rec: BudgetRecommendations = {
      level: 'reduce_depth',
      shouldProceed: true,
      adjustments: {
        maxPropagationDepth: 2,
        maxFilesToAnalyze: 5,
        enableWebSearch: false,
        enableDetailedAnalysis: true,
      },
      message: 'Reducing propagation depth to stay within budget.',
    };
    expect(rec.level).toBe('reduce_depth');
    expect(rec.shouldProceed).toBe(true);
    expect(rec.adjustments.maxFilesToAnalyze).toBe(5);
  });
});
