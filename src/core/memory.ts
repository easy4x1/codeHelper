import type {
  RepoMemory,
  TaskContext,
  LearnedMemory,
  MemoryLayer,
  KnowledgeGraph,
  FileFingerprint,
  Finding,
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
    this.learnedMemory = layer?.learnedMemory ? { ...layer.learnedMemory } : { ...DEFAULT_LEARNED_MEMORY };
  }

  // Repo Memory (L1)
  getRepoMemory(): RepoMemory {
    return { ...this.repoMemory };
  }

  setRepoMemory(repoMemory: RepoMemory): void {
    this.repoMemory = repoMemory;
  }

  getKnowledgeGraph(): KnowledgeGraph {
    return this.repoMemory.knowledgeGraph;
  }

  setKnowledgeGraph(graph: KnowledgeGraph): void {
    this.repoMemory = { ...this.repoMemory, knowledgeGraph: graph };
  }

  getFingerprint(filePath: string): FileFingerprint | undefined {
    return this.repoMemory.fingerprints[filePath];
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

  // Learned Memory (L3)
  getLearnedMemory(): LearnedMemory {
    return { ...this.learnedMemory };
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
