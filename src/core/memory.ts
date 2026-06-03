import type {
  RepoMemory,
  TaskContext,
  LearnedMemory,
  MemoryLayer,
  KnowledgeGraph,
  FileFingerprint,
  Finding,
  TokenBudgetStatus,
  TaskRecord,
  FaultPattern,
  FixPattern,
  Convention,
} from './types.js';

const DEFAULT_REPO_MEMORY: RepoMemory = {
  knowledgeGraph: { nodes: [], edges: [], version: '1.0.0', timestamp: new Date().toISOString() },
  fingerprints: {},
  importMap: {},
  version: '1.0.0',
};

const DEFAULT_TASK_CONTEXT: TaskContext = {
  taskId: '',
  analyzedFiles: new Set(),
  recalledNodes: [],
  findings: [],
};

const DEFAULT_LEARNED_MEMORY: LearnedMemory = {
  taskHistory: [],
  faultPatterns: [],
  fixPatterns: [],
  projectConventions: [],
};

export class MemoryMiddleware {
  private repoMemory: RepoMemory;
  private taskContext: TaskContext;
  private learnedMemory: LearnedMemory;

  constructor(layer?: Partial<MemoryLayer>) {
    this.repoMemory = layer?.repoMemory ? { ...layer.repoMemory } : { ...DEFAULT_REPO_MEMORY };
    this.taskContext = layer?.taskContext
      ? { ...layer.taskContext, analyzedFiles: new Set(layer.taskContext.analyzedFiles) }
      : { ...DEFAULT_TASK_CONTEXT };
    this.learnedMemory = layer?.learnedMemory
      ? JSON.parse(JSON.stringify(layer.learnedMemory))
      : { ...DEFAULT_LEARNED_MEMORY, taskHistory: [], faultPatterns: [], fixPatterns: [], projectConventions: [] };
  }

  // Repo Memory (L1)
  getRepoMemory(): RepoMemory {
    return { ...this.repoMemory };
  }

  setRepoMemory(repoMemory: RepoMemory): void {
    this.repoMemory = JSON.parse(JSON.stringify(repoMemory));
  }

  getKnowledgeGraph(): KnowledgeGraph {
    return JSON.parse(JSON.stringify(this.repoMemory.knowledgeGraph));
  }

  setKnowledgeGraph(graph: KnowledgeGraph): void {
    this.repoMemory = { ...this.repoMemory, knowledgeGraph: graph };
  }

  getFingerprint(filePath: string): FileFingerprint | undefined {
    const fp = this.repoMemory.fingerprints[filePath];
    return fp ? JSON.parse(JSON.stringify(fp)) : undefined;
  }

  setFingerprint(fp: FileFingerprint): void {
    this.repoMemory.fingerprints[fp.filePath] = fp;
  }

  getAllFingerprints(): Record<string, FileFingerprint> {
    return { ...this.repoMemory.fingerprints };
  }

  // Task Context (L2)
  startTask(taskId: string): void {
    this.taskContext = {
      taskId,
      analyzedFiles: new Set(),
      recalledNodes: [],
      findings: [],
    };
  }

  // ---- Search cache (L2) ----

  recordSearchResult(taskId: string, result: { title: string; url: string; snippet: string; credibilityScore: number }): void {
    if (this.taskContext.taskId !== taskId) {
      this.startTask(taskId);
    }
    if (!this.taskContext.searchCache) {
      this.taskContext.searchCache = [];
    }
    this.taskContext.searchCache.push(result);
  }

  getCachedSearchResults(taskId: string): Array<{ title: string; url: string; snippet: string; credibilityScore: number }> {
    if (this.taskContext.taskId !== taskId) {
      return [];
    }
    return this.taskContext.searchCache ? [...this.taskContext.searchCache] : [];
  }

  getTaskContext(): TaskContext {
    return {
      ...this.taskContext,
      analyzedFiles: new Set(this.taskContext.analyzedFiles),
    };
  }

  markFileAnalyzed(filePath: string): void {
    this.taskContext.analyzedFiles.add(filePath);
  }

  addFinding(finding: Finding): void {
    this.taskContext.findings.push(finding);
  }

  // Token Budget (L2 — cross-session tracking)
  getTokenBudget(): TokenBudgetStatus | undefined {
    return this.taskContext.tokenBudget
      ? JSON.parse(JSON.stringify(this.taskContext.tokenBudget))
      : undefined;
  }

  setTokenBudget(status: TokenBudgetStatus): void {
    this.taskContext.tokenBudget = JSON.parse(JSON.stringify(status));
  }

  // Learned Memory (L3)
  getLearnedMemory(): LearnedMemory {
    return JSON.parse(JSON.stringify(this.learnedMemory));
  }

  // ---- Task History ----

  recordTask(record: TaskRecord & { success?: boolean }): void {
    this.learnedMemory.taskHistory.push({
      ...record,
      timestamp: record.timestamp || new Date().toISOString(),
    });
  }

  getTaskHistory(): TaskRecord[] {
    return JSON.parse(JSON.stringify(this.learnedMemory.taskHistory));
  }

  // ---- Pattern Library ----

  addFaultPattern(pattern: FaultPattern): void {
    const existing = this.learnedMemory.faultPatterns.find(p => p.id === pattern.id);
    if (existing) {
      existing.frequency += pattern.frequency;
    } else {
      this.learnedMemory.faultPatterns.push({ ...pattern });
    }
  }

  addFixPattern(pattern: FixPattern): void {
    const existing = this.learnedMemory.fixPatterns.find(p => p.id === pattern.id);
    if (existing) {
      existing.frequency += pattern.frequency;
    } else {
      this.learnedMemory.fixPatterns.push({ ...pattern });
    }
  }

  // ---- Project Conventions ----

  addConvention(convention: Convention): void {
    const existing = this.learnedMemory.projectConventions.find(
      c => c.category === convention.category && c.rule === convention.rule
    );
    if (existing) {
      // Increase confidence with additional evidence
      existing.confidence = Math.min(1, existing.confidence + 0.1);
    } else {
      this.learnedMemory.projectConventions.push({ ...convention });
    }
  }

  getConventions(category?: Convention['category']): Convention[] {
    const conventions = JSON.parse(JSON.stringify(this.learnedMemory.projectConventions));
    return category ? conventions.filter((c: Convention) => c.category === category) : conventions;
  }

  // Serialization
  serialize(): string {
    const layer: MemoryLayer = {
      repoMemory: this.repoMemory,
      taskContext: {
        ...this.taskContext,
        analyzedFiles: Array.from(this.taskContext.analyzedFiles),
      } as unknown as TaskContext,
      learnedMemory: this.learnedMemory,
    };
    return JSON.stringify(layer, null, 2);
  }

  static deserialize(json: string): MemoryMiddleware {
    const parsed = JSON.parse(json) as MemoryLayer;
    return new MemoryMiddleware({
      repoMemory: parsed.repoMemory,
      taskContext: {
        ...parsed.taskContext,
        analyzedFiles: new Set(parsed.taskContext.analyzedFiles as unknown as string[]),
      },
      learnedMemory: parsed.learnedMemory,
    });
  }
}
