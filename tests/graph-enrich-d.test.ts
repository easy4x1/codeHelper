import { describe, it, expect } from 'vitest';
import { KnowledgeGraphBuilder } from '../src/core/knowledge-graph.js';
import { TemplateLlmService } from '../src/core/llm-service.js';
import { LlmSemanticCache } from '../src/core/llm-semantic-cache.js';
import {
  runEnrichers,
  D_LAYER_ENRICHERS,
  summaryEnricher,
  conceptNamingEnricher,
  architectureLayerEnricher,
  semanticEdgeEnricher,
} from '../src/core/graph-enrich.js';
import type { FileFingerprint } from '../src/core/types.js';

function createFixture(): {
  builder: KnowledgeGraphBuilder;
  fingerprints: Record<string, FileFingerprint>;
  sources: Record<string, string>;
} {
  const builder = new KnowledgeGraphBuilder();
  const filePath = 'src/auth-service.ts';
  const fingerprints: Record<string, FileFingerprint> = {
    [filePath]: {
      filePath,
      contentHash: 'auth-hash',
      functions: [
        { name: 'loginUser', params: ['username', 'password'], returnType: 'string', isExported: true, startLine: 1, endLine: 10 },
        { name: 'validatePassword', params: ['password'], returnType: 'boolean', isExported: false, startLine: 12, endLine: 20 },
      ],
      classes: [],
      imports: [],
      exports: [{ name: 'loginUser', type: 'function', line: 1 }],
      totalLines: 25,
      hasStructuralAnalysis: true,
    },
  };

  builder.addNode({ id: `file:${filePath}`, type: 'file', name: 'auth-service.ts', filePath });
  builder.addNode({ id: `function:${filePath}:loginUser`, type: 'function', name: 'loginUser', filePath });
  builder.addNode({ id: `function:${filePath}:validatePassword`, type: 'function', name: 'validatePassword', filePath });
  builder.addEdge(`file:${filePath}`, `function:${filePath}:loginUser`, 'contains', 1.0);
  builder.addEdge(`file:${filePath}`, `function:${filePath}:validatePassword`, 'contains', 1.0);

  // C-layer style anonymous concept cluster
  builder.addNode({ id: 'concept:cluster:abc123', type: 'concept', name: 'cluster-abc123' });
  builder.addEdge(`function:${filePath}:loginUser`, 'concept:cluster:abc123', 'related', 0.5);
  builder.addEdge(`function:${filePath}:validatePassword`, 'concept:cluster:abc123', 'related', 0.5);

  const sources: Record<string, string> = {
    [filePath]: `
export function loginUser(username: string, password: string): string {
  if (validatePassword(password)) {
    return createSession(username);
  }
  throw new Error('invalid');
}

function validatePassword(password: string): boolean {
  return password.length > 8;
}
`,
  };

  return { builder, fingerprints, sources };
}

describe('D-layer enrichers', () => {
  it('summaryEnricher updates node summaries and tags', async () => {
    const { builder, fingerprints, sources } = createFixture();
    const llm = new TemplateLlmService();

    await summaryEnricher.enrich(builder, fingerprints, { enabledLayers: ['D'], sources, llm });

    const loginNode = builder.findNode('function:src/auth-service.ts:loginUser');
    expect(loginNode?.summary).toBeTruthy();
    expect(loginNode?.tags?.length).toBeGreaterThan(0);
  });

  it('conceptNamingEnricher renames anonymous clusters', async () => {
    const { builder, fingerprints, sources } = createFixture();
    const llm = new TemplateLlmService();

    await runEnrichers(
      builder,
      fingerprints,
      { enabledLayers: ['D'], sources, llm },
      [summaryEnricher, conceptNamingEnricher]
    );

    const cluster = builder.findNode('concept:cluster:abc123');
    expect(cluster?.name).not.toBe('cluster-abc123');
    expect(cluster?.name).toContain('cluster');
  });

  it('architectureLayerEnricher creates layer concept nodes', async () => {
    const { builder, fingerprints, sources } = createFixture();
    const llm = new TemplateLlmService();

    await architectureLayerEnricher.enrich(builder, fingerprints, { enabledLayers: ['D'], sources, llm });

    const fileNode = builder.findNode('file:src/auth-service.ts');
    expect(fileNode?.tags?.some(t => t.startsWith('layer:'))).toBe(true);
    const graph = builder.build();
    expect(graph.nodes.some(n => n.type === 'concept' && n.id.startsWith('concept:layer:'))).toBe(true);
    expect(graph.edges.some(e => e.type === 'related' && e.target.startsWith('concept:layer:'))).toBe(true);
  });

  it('semanticEdgeEnricher creates transforms/validates edges', async () => {
    const { builder, fingerprints, sources } = createFixture();
    const llm = new TemplateLlmService();

    await semanticEdgeEnricher.enrich(builder, fingerprints, { enabledLayers: ['D'], sources, llm });

    const graph = builder.build();
    expect(graph.edges.some(e => e.type === 'validates')).toBe(true);
  });

  it('D_LAYER_ENRICHERS run only when layer D is enabled', async () => {
    const { builder, fingerprints, sources } = createFixture();
    const llm = new TemplateLlmService();

    await runEnrichers(
      builder,
      fingerprints,
      { enabledLayers: ['A', 'B', 'C'], sources, llm },
      D_LAYER_ENRICHERS
    );

    const loginNode = builder.findNode('function:src/auth-service.ts:loginUser');
    expect(loginNode?.summary).toBeUndefined();
  });

  it('D enrichers self-skip when llm is absent', async () => {
    const { builder, fingerprints, sources } = createFixture();

    await runEnrichers(
      builder,
      fingerprints,
      { enabledLayers: ['D'], sources },
      D_LAYER_ENRICHERS
    );

    const loginNode = builder.findNode('function:src/auth-service.ts:loginUser');
    expect(loginNode?.summary).toBeUndefined();
  });

  it('caches LLM results via LlmSemanticCache', async () => {
    const { builder, fingerprints, sources } = createFixture();
    const llm = new TemplateLlmService();
    const cache = new LlmSemanticCache();

    await summaryEnricher.enrich(builder, fingerprints, { enabledLayers: ['D'], sources, llm, llmCache: cache });
    expect(cache.export().length).toBeGreaterThan(0);

    // Second run should reuse cache (no error even if llm is unavailable, but we keep it for simplicity)
    const builder2 = new KnowledgeGraphBuilder();
    builder2.addNode({ id: 'file:src/auth-service.ts', type: 'file', name: 'auth-service.ts', filePath: 'src/auth-service.ts' });
    builder2.addNode({ id: 'function:src/auth-service.ts:loginUser', type: 'function', name: 'loginUser', filePath: 'src/auth-service.ts' });

    await summaryEnricher.enrich(builder2, fingerprints, { enabledLayers: ['D'], sources, llm, llmCache: cache });
    expect(builder2.findNode('function:src/auth-service.ts:loginUser')?.summary).toBeTruthy();
  });
});
