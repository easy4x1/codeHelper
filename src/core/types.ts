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
  searchCache?: Array<{ title: string; url: string; snippet: string; credibilityScore: number }>;
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

// ============================================
// Propagation Engine Types
// ============================================

export interface PropagationOptions {
  direction: 'upstream' | 'downstream' | 'both';
  maxDepth: number;
  minEdgeWeight: number;
  includeTests: boolean;
}

export interface AffectedNode {
  nodeId: string;
  nodeType: NodeType;
  impactProbability: number;
  distance: number;
  path: string[];
}

export interface RootCauseCandidate {
  nodeId: string;
  nodeType: NodeType;
  confidence: number;
  reasoning: string;
}

export interface PropagationPath {
  fromNodeId: string;
  toNodeId: string;
  edgeType: EdgeType;
  weight: number;
}

export interface PropagationResult {
  entryPoints: string[];
  affectedNodes: AffectedNode[];
  rootCauseCandidates: RootCauseCandidate[];
  propagationPaths: PropagationPath[];
}

// ============================================
// Web Search Types
// ============================================

export interface SearchTemplate {
  name: string;
  template: string;
  priority: number;
  example: string;
}

export interface WebSearchQuery {
  query: string;
  templates: string[];
  language?: string;
  framework?: string;
  errorMessage?: string;
  stackTraceTopFrame?: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  credibilityScore: number; // 0-1
}

export interface WebSearchStrategy {
  triggers: {
    localConfidenceThreshold: number;
    noveltyThreshold: number;
    minQueryQuality: number;
  };
  queryBuilder: {
    templates: SearchTemplate[];
    enrichment: {
      includeStackTrace: boolean;
      includeVersions: boolean;
      includeContext: boolean;
    };
  };
  fusion: {
    strategy: 'weighted' | 'fallback' | 'ensemble';
    weights: {
      localKnowledge: number;
      webSearch: number;
      historicalFix: number;
    };
  };
}

// ============================================
// Token Budget Types
// ============================================

export interface TokenBudgetConfig {
  total: number;
  allocated: {
    analysis: number;
    search: number;
    planning: number;
    review: number;
  };
}

export interface TokenBudgetStatus {
  total: number;
  allocated: {
    analysis: number;
    search: number;
    planning: number;
    review: number;
  };
  used: number;
  remaining: number;
  usageByCategory: {
    analysis: number;
    search: number;
    planning: number;
    review: number;
  };
}

export type DegradationLevel =
  | 'none'
  | 'reduce_depth'
  | 'disable_search'
  | 'core_only'
  | 'prompt_user';

export interface BudgetRecommendations {
  level: DegradationLevel;
  shouldProceed: boolean;
  adjustments: {
    maxPropagationDepth?: number;
    maxFilesToAnalyze?: number;
    enableWebSearch?: boolean;
    enableDetailedAnalysis?: boolean;
  };
  message: string;
}

// ============================================
// Zod Runtime Validation Schemas
// ============================================

import { z } from 'zod';

export const findingSchema = z.object({
  id: z.string(),
  type: z.enum(['fault', 'pattern', 'insight']),
  description: z.string(),
  confidence: z.number().min(0).max(1),
  nodeIds: z.array(z.string()),
});

export const repoScannerContextSchema = z.object({
  repoPath: z.string(),
});

export const faultDetectorContextSchema = z.object({
  targetFiles: z.array(z.string()).optional().default([]),
  repoPath: z.string().optional().default('.'),
});

export const contextBuilderContextSchema = z.object({
  nodeIds: z.array(z.string()),
});

export const solutionPlannerContextSchema = z.object({
  problem: z.string(),
  findings: z.array(findingSchema).optional().default([]),
  affectedFiles: z.array(z.string()).optional().default([]),
  repoPath: z.string().optional().default('.'),
  searchResults: z.array(z.object({
    title: z.string(),
    snippet: z.string(),
    credibility: z.number(),
  })).optional().default([]),
});

export const patchGeneratorContextSchema = z.object({
  plan: z.record(z.string(), z.unknown()),
});

export const webSearcherContextSchema = z.object({
  findings: z.array(findingSchema).optional().default([]),
  language: z.string().optional().default('typescript'),
  framework: z.string().optional(),
  errorMessage: z.string().optional(),
  stackTrace: z.string().optional(),
});

/**
 * Safely parse agent context against a Zod schema.
 * Throws a descriptive error if validation fails.
 */
export function parseContext<T extends z.ZodTypeAny>(
  context: Record<string, unknown>,
  schema: T
): z.infer<T> {
  const result = schema.safeParse(context);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid agent context: ${issues}`);
  }
  return result.data;
}
