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
  /** Names of functions/methods invoked in the body (callee identifiers), used to build `calls` edges. */
  calls?: string[];
}

export interface ClassSignature {
  name: string;
  methods: string[];
  properties: string[];
  isExported: boolean;
  startLine: number;
  endLine: number;
  /** Name of the superclass this class extends, used to build `inherits` edges. */
  superClass?: string;
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
  /** Token budget status for cross-session tracking (DESIGN.md 3.2.1) */
  tokenBudget?: TokenBudgetStatus;
}

export interface Finding {
  id: string;
  type: 'fault' | 'pattern' | 'insight' | 'style';
  description: string;
  confidence: number;
  nodeIds: string[];
}

export interface LearnedMemory {
  taskHistory: TaskRecord[];
  faultPatterns: FaultPattern[];
  fixPatterns: FixPattern[];
  projectConventions: Convention[];
}

export interface TaskRecord {
  taskId: string;
  description: string;
  timestamp: string;
  filesAnalyzed: string[];
  findingsCount: number;
  success?: boolean;
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

export interface Convention {
  id: string;
  category: 'naming' | 'style' | 'architecture' | 'testing' | 'documentation';
  rule: string;
  examples: string[];
  confidence: number; // 0-1
  source?: string; // file path or taskId that originated this convention
}

export interface MemoryLayer {
  repoMemory: RepoMemory;
  taskContext: TaskContext;
  learnedMemory: LearnedMemory;
  /** Cross-task plan cache keyed by description keywords (persisted for CLI reuse). */
  semanticCache?: SemanticCacheEntry[];
  /** Cross-task analysis-result cache keyed by filePath::contentHash (persisted, LRU-capped). */
  resultCache?: ResultCacheEntry[];
}

/** One cached SolutionPlan keyed by the tokenized keywords of its task description. */
export interface SemanticCacheEntry {
  keywords: string[];
  plan: SolutionPlan;
  timestamp: string;
}

/** One cached analysis result keyed by `filePath::contentHash`. */
export interface ResultCacheEntry {
  key: string;
  findings: Finding[];
  timestamp: string;
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
// Repair Orchestration Types
// ============================================

import type { FilePatch, PatchResult } from './patch.js';

/** Context passed to a review gate before patches are written to disk. */
export interface ReviewContext {
  plan: SolutionPlan;
  patches: FilePatch[];
  summary: PatchResult['summary'];
}

/** Options controlling how a SolutionPlan is turned into applied changes. */
export interface ApplyPlanOptions {
  /** Generate patches but do not write them to disk (default: false). */
  dryRun?: boolean;
  /** Run the git workflow (commit/push) after applying (default: true). */
  push?: boolean;
  /**
   * Gate invoked before patches are written. Return `true` to apply,
   * `false` to abort. Interactive front-ends inject their own prompt here.
   * Omit to approve automatically.
   */
  review?: (ctx: ReviewContext) => Promise<boolean>;
  /** Record the completed task into L3 learned memory (default: true). */
  record?: boolean;
}

/** Structured result of applying a plan — front-ends render this. */
export interface RepairOutcome {
  plan: SolutionPlan;
  patches: FilePatch[];
  summary: PatchResult['summary'];
  approved: boolean;
  applied: string[];
  failed: string[];
  git?: { success: boolean; messages: string[]; errors: string[]; prUrl?: string };
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
  /** Max BFS depth for propagation; injected from the token budget's degradation policy. 0 = no traversal. */
  maxPropagationDepth: z.number().int().nonnegative().optional(),
});

export const rootCauseAnalyzerContextSchema = z.object({
  problem: z.string(),
  findings: z.array(findingSchema).optional().default([]),
  codeContext: z.array(z.object({
    filePath: z.string(),
    code: z.string(),
  })).optional().default([]),
  searchResults: z.array(z.object({
    title: z.string(),
    snippet: z.string(),
    credibility: z.number(),
  })).optional().default([]),
  propagationResult: z.record(z.string(), z.unknown()).optional(),
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
  rootCause: z.string().optional().default('Root cause analysis pending'),
  severity: z.string().optional().default('medium'),
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
