// ============================================
// Node Types
// ============================================
export type NodeType =
  | 'file'
  | 'function'
  | 'class'
  | 'module'
  | 'concept'
  | 'config'
  | 'document'
  | 'service'
  | 'table'
  | 'endpoint'
  | 'pipeline'
  | 'schema'
  | 'resource'
  | 'fault'
  | 'fix'
  | 'pattern';

export type EdgeType =
  | 'contains'
  | 'imports'
  | 'exports'
  | 'inherits'
  | 'implements'
  | 'calls'
  | 'subscribes'
  | 'publishes'
  | 'middleware'
  | 'reads_from'
  | 'writes_to'
  | 'transforms'
  | 'validates'
  | 'depends_on'
  | 'tested_by'
  | 'configures'
  | 'related'
  | 'similar_to'
  | 'deploys'
  | 'serves'
  | 'provisions'
  | 'triggers'
  | 'migrates'
  | 'documents'
  | 'routes'
  | 'defines_schema'
  | 'fixes'
  | 'mitigates'
  | 'relates_to_fault'
  | 'suggests'
  | 'learned_from';

export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  filePath?: string;
  summary?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  weight: number;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  version: string;
  timestamp: string;
}

// ============================================
// Fingerprint Types
// ============================================
export interface FunctionSignature {
  name: string;
  params: string[];
  returnType?: string;
  isExported: boolean;
  startLine: number;
  endLine: number;
}

export interface ClassSignature {
  name: string;
  methods: string[];
  properties: string[];
  isExported: boolean;
  startLine: number;
  endLine: number;
}

export interface ImportSignature {
  source: string;
  items: string[];
  isDefault?: boolean;
  line: number;
}

export interface ExportSignature {
  name: string;
  type: 'function' | 'class' | 'variable' | 'default';
  line: number;
}

export interface FileFingerprint {
  filePath: string;
  contentHash: string;
  functions: FunctionSignature[];
  classes: ClassSignature[];
  imports: ImportSignature[];
  exports: ExportSignature[];
  totalLines: number;
  hasStructuralAnalysis: boolean;
}

export type ChangeLevel = 'NONE' | 'COSMETIC' | 'STRUCTURAL' | 'SEMANTIC';

export interface ChangeAnalysis {
  filePath: string;
  changeLevel: ChangeLevel;
  details: string[];
}

// ============================================
// Memory Types
// ============================================
export interface RepoMemory {
  knowledgeGraph: KnowledgeGraph;
  fingerprints: Record<string, FileFingerprint>;
  importMap: Record<string, string[]>;
  version: string;
}

export interface TaskContext {
  taskId: string;
  analyzedFiles: Set<string>;
  recalledNodes: GraphNode[];
  findings: Finding[];
}

export interface Finding {
  id: string;
  type: 'fault' | 'pattern' | 'insight';
  description: string;
  confidence: number;
  nodeIds: string[];
}

export interface LearnedMemory {
  taskHistory: TaskRecord[];
  faultPatterns: FaultPattern[];
  fixPatterns: FixPattern[];
}

export interface TaskRecord {
  taskId: string;
  description: string;
  timestamp: string;
  filesAnalyzed: string[];
  findingsCount: number;
}

export interface FaultPattern {
  id: string;
  pattern: string;
  language?: string;
  frequency: number;
}

export interface FixPattern {
  id: string;
  pattern: string;
  language?: string;
  frequency: number;
}

export interface MemoryLayer {
  repoMemory: RepoMemory;
  taskContext: TaskContext;
  learnedMemory: LearnedMemory;
}

// ============================================
// Agent Types
// ============================================
export interface AgentInput {
  taskId: string;
  instruction: string;
  context: Record<string, unknown>;
}

export interface AgentOutput {
  taskId: string;
  agentName: string;
  result: Record<string, unknown>;
  findings: Finding[];
}

export interface RepairTask {
  id: string;
  description: string;
  type: 'bug' | 'feature' | 'refactor' | 'performance' | 'security';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  context?: {
    files?: string[];
    errorLog?: string;
    stackTrace?: string;
  };
  constraints?: {
    maxFiles?: number;
    breakingChanges?: boolean;
    testRequired?: boolean;
  };
}

export interface SolutionPlan {
  id: string;
  timestamp: string;
  taskId: string;
  problem: {
    description: string;
    rootCause: string;
    severity: string;
  };
  changes: FileChange[];
  metadata: {
    confidence: number;
    tokenUsed: number;
  };
}

export interface FileChange {
  filePath: string;
  changeType: 'modify' | 'add' | 'delete' | 'rename';
  description: string;
  reasoning: string;
  originalCode?: string;
  modifiedCode?: string;
}
