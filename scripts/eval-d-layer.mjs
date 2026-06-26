#!/usr/bin/env node

/**
 * D-layer LLM semantic enrichment eval script.
 *
 * Run with a real LLM provider (e.g. anthropic) to verify that summaries,
 * concept cluster names, architecture layers, and semantic edges make sense.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=xxx node scripts/eval-d-layer.mjs [repo-path]
 */

import { CodeRepairAgent } from '../src/index.js';
import { join, resolve } from 'path';

const repoPath = resolve(process.argv[2] ?? './tests/fixtures/sample-repo');
const memoryPath = join(repoPath, '.repair-agent', 'memory.json');

const agent = new CodeRepairAgent({
  verbose: true,
  provider: process.env.LLM_PROVIDER || 'anthropic',
  model: process.env.LLM_MODEL,
  semanticEnrichment: true,
});

await agent.loadMemory(memoryPath);
const result = await agent.init(repoPath);
await agent.saveMemory(memoryPath);

const graph = agent.getMemory().getKnowledgeGraph();

console.log('\n=== D-layer eval ===\n');
console.log(`Scanned ${result.fingerprintCount} files`);
console.log(`Nodes: ${graph.nodes.length}`);
console.log(`Edges: ${graph.edges.length}\n`);

console.log('=== File summaries ===');
for (const node of graph.nodes.filter(n => n.type === 'file')) {
  console.log(`- ${node.name}`);
  console.log(`  summary: ${node.summary || '(none)'}`);
  console.log(`  tags:    ${(node.tags || []).join(', ') || '(none)'}`);
}

console.log('\n=== Concept clusters ===');
for (const node of graph.nodes.filter(n => n.type === 'concept' && n.id.startsWith('concept:cluster:'))) {
  console.log(`- ${node.id} → ${node.name}`);
}

console.log('\n=== Architecture layers ===');
for (const node of graph.nodes.filter(n => n.type === 'concept' && n.id.startsWith('concept:layer:'))) {
  const memberCount = graph.edges.filter(e => e.target === node.id && e.type === 'related').length;
  console.log(`- ${node.name}: ${memberCount} member(s)`);
}

console.log('\n=== Semantic edges ===');
for (const edge of graph.edges.filter(e => e.type === 'transforms' || e.type === 'validates')) {
  console.log(`- ${edge.source} --${edge.type}--> ${edge.target} (w=${edge.weight.toFixed(2)})`);
}

console.log('\nPlease review the outputs above. If they look semantically reasonable, D-layer is considered done.\n');
