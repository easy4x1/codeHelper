import { describe, it, expect } from 'vitest';
import { scanRepo, buildImportMap } from '../src/core/repo-scanner.js';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'sample-repo');

describe('repo-scanner', () => {
  it('scans repo and returns files', async () => {
    const result = await scanRepo(fixturePath);
    const filePaths = result.files.map(f => f.filePath);
    expect(filePaths).toContain('src/index.ts');
    expect(filePaths).toContain('src/utils.ts');
    expect(filePaths).not.toContain('package.json');
  });

  it('computes fingerprints for all files', async () => {
    const result = await scanRepo(fixturePath);
    expect(result.fingerprints).toHaveLength(2);
    const indexFp = result.fingerprints.find(f => f.filePath === 'src/index.ts');
    expect(indexFp).toBeDefined();
    expect(indexFp!.functions).toHaveLength(1);
    expect(indexFp!.classes).toHaveLength(1);
    expect(indexFp!.imports).toHaveLength(1);
    expect(indexFp!.exports).toHaveLength(2);
  });

  it('builds import map', async () => {
    const result = await scanRepo(fixturePath);
    const importMap = buildImportMap(result.fingerprints);
    expect(importMap['src/index.ts']).toContain('./utils.js');
  });

  it('collects classifiable non-source asset files', async () => {
    const result = await scanRepo(fixturePath);
    expect(result.assetFiles).toContain('package.json');
    // source files are not asset files
    expect(result.assetFiles).not.toContain('src/index.ts');
  });
});
