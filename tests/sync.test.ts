import { describe, it, expect } from 'vitest';
import { syncRepo } from '../src/core/sync.js';
import { MemoryMiddleware } from '../src/core/memory.js';
import { KnowledgeGraphBuilder } from '../src/core/knowledge-graph.js';
import { computeFingerprint } from '../src/core/fingerprint.js';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'sample-repo');

describe('syncRepo', () => {
  it('detects no changes when repo is unchanged', async () => {
    const memory = new MemoryMiddleware();

    const indexFp = computeFingerprint('src/index.ts', `import { helper } from './utils.js';

export function main(): void {
  const result = helper();
  console.log(result);
}

export class App {
  run(): void {
    main();
  }
}
`);
    const utilsFp = computeFingerprint('src/utils.ts', `export function helper(): string {
  return 'hello';
}
`);

    memory.setFingerprint(indexFp);
    memory.setFingerprint(utilsFp);

    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'file:src/index.ts', type: 'file', name: 'index.ts', filePath: 'src/index.ts' });
    memory.setKnowledgeGraph(builder.build());

    const result = await syncRepo(memory, { repoPath: fixturePath });

    expect(result.filesAnalyzed).toBe(2);
    expect(result.filesUnchanged).toBe(2);
    expect(result.filesStructural).toBe(0);
    expect(result.filesAdded).toBe(0);
    expect(result.filesDeleted).toBe(0);
  });

  it('detects structural change when function signature changes', async () => {
    const memory = new MemoryMiddleware();

    const indexFp = computeFingerprint('src/index.ts', `import { helper } from './utils.js';
export function main(): void { helper(); }
`);
    const utilsFp = computeFingerprint('src/utils.ts', `export function helper(): string { return 'hello'; }`);

    memory.setFingerprint(indexFp);
    memory.setFingerprint(utilsFp);

    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'file:src/index.ts', type: 'file', name: 'index.ts', filePath: 'src/index.ts' });
    memory.setKnowledgeGraph(builder.build());

    const result = await syncRepo(memory, { repoPath: fixturePath });

    expect(result.filesAnalyzed).toBe(2);
    expect(result.filesStructural).toBeGreaterThanOrEqual(1);
  });

  it('detects deleted files', async () => {
    const memory = new MemoryMiddleware();

    const indexFp = computeFingerprint('src/index.ts', `export function main() {}`);
    const oldFp = computeFingerprint('src/old-file.ts', `export function oldFunc() {}`);

    memory.setFingerprint(indexFp);
    memory.setFingerprint(oldFp);

    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'file:src/old-file.ts', type: 'file', name: 'old-file.ts', filePath: 'src/old-file.ts' });
    memory.setKnowledgeGraph(builder.build());

    const result = await syncRepo(memory, { repoPath: fixturePath });

    expect(result.filesDeleted).toBe(1);
    const deletedChange = result.changes.find(c => c.filePath === 'src/old-file.ts');
    expect(deletedChange).toBeDefined();
    expect(deletedChange!.changeLevel).toBe('STRUCTURAL');
    expect(deletedChange!.details).toContain('File deleted');
  });

  it('force-full reanalyzes all files', async () => {
    const memory = new MemoryMiddleware();

    const indexFp = computeFingerprint('src/index.ts', `import { helper } from './utils.js';
export function main(): void {}
`);
    const utilsFp = computeFingerprint('src/utils.ts', `export function helper(): string { return 'hello'; }`);

    memory.setFingerprint(indexFp);
    memory.setFingerprint(utilsFp);

    const result = await syncRepo(memory, { repoPath: fixturePath, forceFull: true });

    expect(result.filesStructural).toBe(2);
  });

  it('updates memory graph after sync', async () => {
    const memory = new MemoryMiddleware();

    const indexFp = computeFingerprint('src/index.ts', `import { helper } from './utils.js';

export function main(): void {
  const result = helper();
  console.log(result);
}

export class App {
  run(): void {
    main();
  }
}
`);
    const utilsFp = computeFingerprint('src/utils.ts', `export function helper(): string {
  return 'hello';
}
`);

    memory.setFingerprint(indexFp);
    memory.setFingerprint(utilsFp);

    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'file:src/index.ts', type: 'file', name: 'index.ts', filePath: 'src/index.ts' });
    memory.setKnowledgeGraph(builder.build());

    const result = await syncRepo(memory, { repoPath: fixturePath });

    expect(result.updatedGraph.nodes.length).toBeGreaterThan(0);
    expect(Object.keys(result.updatedFingerprints).length).toBe(2);
  });

  it('runs A-layer enrichers (depends_on edge + asset classifier node)', async () => {
    const memory = new MemoryMiddleware();
    memory.setFingerprint(computeFingerprint('src/index.ts', `import { helper } from './utils.js';
export function main(): void { helper(); }
`));
    memory.setFingerprint(computeFingerprint('src/utils.ts', `export function helper(): string { return 'hello'; }`));

    const result = await syncRepo(memory, { repoPath: fixturePath, forceFull: true });

    const edges = result.updatedGraph.edges;
    expect(edges.some(e => e.source === 'file:src/index.ts' && e.type === 'depends_on' && e.target === 'file:src/utils.ts')).toBe(true);
    expect(result.updatedGraph.nodes.some(n => n.id === 'config:package.json' && n.type === 'config')).toBe(true);
  });
});
