import { BaseAgent } from './base-agent.js';
import { scanRepo, buildImportMap } from '../core/repo-scanner.js';
import { MemoryMiddleware } from '../core/memory.js';
import type { AgentInput } from '../core/types.js';
import { repoScannerContextSchema, parseContext } from '../core/types.js';

export class RepoScannerAgent extends BaseAgent {
  constructor(private memory: MemoryMiddleware) {
    super('repo-scanner');
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const { repoPath } = parseContext(input.context, repoScannerContextSchema);

    this.logger.info(`Scanning repository at ${repoPath}`);
    const result = await scanRepo(repoPath);

    // Store fingerprints in memory
    for (const fp of result.fingerprints) {
      this.memory.setFingerprint(fp);
    }

    const importMap = buildImportMap(result.fingerprints);
    const repoMemory = this.memory.getRepoMemory();
    repoMemory.importMap = importMap;
    this.memory.setRepoMemory(repoMemory);

    this.logger.info(`Scanned ${result.files.length} files, ${result.fingerprints.length} fingerprints`);

    return {
      files: result.files.map(f => f.filePath),
      fingerprintCount: result.fingerprints.length,
      languages: Array.from(result.languages),
      importMap,
    };
  }
}
