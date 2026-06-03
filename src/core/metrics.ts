import { writeFile, readFile, access } from 'fs/promises';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('metrics');

// Global singleton for easy access across modules
let globalCollector: MetricsCollector | null = null;

export function setGlobalMetricsCollector(collector: MetricsCollector): void {
  globalCollector = collector;
}

export function getGlobalMetricsCollector(): MetricsCollector | null {
  return globalCollector;
}

// ============================================
// Metric Types
// ============================================

export interface AgentMetric {
  agentName: string;
  callCount: number;
  totalDurationMs: number;
  successCount: number;
  failureCount: number;
}

export interface CacheMetric {
  totalQueries: number;
  hits: number;
  misses: number;
  /** Best similarity score for each query (for distribution analysis) */
  similarityScores: number[];
}

export interface TokenMetric {
  analysis: number;
  search: number;
  planning: number;
  review: number;
}

export interface TaskMetric {
  taskType: 'plan' | 'fix' | 'sync' | 'learn';
  success: boolean;
  durationMs: number;
  timestamp: string;
  tokenUsed: number;
}

export interface ParserMetric {
  treeSitterFiles: number;
  regexFiles: number;
  byLanguage: Record<string, { treeSitter: number; regex: number }>;
}

export interface GraphMetric {
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
}

export interface MetricsSnapshot {
  version: number;
  startedAt: string;
  lastUpdatedAt: string;
  agents: Record<string, AgentMetric>;
  cache: CacheMetric;
  tokens: TokenMetric;
  tasks: TaskMetric[];
  parser: ParserMetric;
  graph: GraphMetric;
  /** Incremental analysis savings: tokens saved by fingerprint skip */
  incrementalSavings: {
    filesSkipped: number;
    filesReanalyzed: number;
    estimatedTokensSaved: number;
  };
}

// ============================================
// MetricsCollector
// ============================================

const DEFAULT_PATH = '.repair-agent/metrics.json';

export class MetricsCollector {
  private data: MetricsSnapshot;
  private path: string;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: { path?: string; autoFlushIntervalMs?: number }) {
    this.path = options?.path ?? DEFAULT_PATH;
    this.data = this.createEmptySnapshot();

    if (options?.autoFlushIntervalMs) {
      this.flushTimer = setInterval(() => this.flush(), options.autoFlushIntervalMs);
    }
  }

  // ---------- Agent Metrics ----------

  recordAgentExecution(agentName: string, durationMs: number, success: boolean): void {
    const agent = this.getOrCreateAgent(agentName);
    agent.callCount++;
    agent.totalDurationMs += durationMs;
    if (success) {
      agent.successCount++;
    } else {
      agent.failureCount++;
    }
    this.touch();
  }

  // ---------- Cache Metrics ----------

  recordCacheQuery(similarityScore: number, hit: boolean): void {
    this.data.cache.totalQueries++;
    this.data.cache.similarityScores.push(similarityScore);
    // Keep only last 1000 scores to prevent unbounded growth
    if (this.data.cache.similarityScores.length > 1000) {
      this.data.cache.similarityScores = this.data.cache.similarityScores.slice(-1000);
    }
    if (hit) {
      this.data.cache.hits++;
    } else {
      this.data.cache.misses++;
    }
    this.touch();
  }

  // ---------- Token Metrics ----------

  recordTokenUsage(category: keyof TokenMetric, tokens: number): void {
    this.data.tokens[category] += Math.max(0, tokens);
    this.touch();
  }

  // ---------- Task Metrics ----------

  recordTask(taskType: TaskMetric['taskType'], success: boolean, durationMs: number, tokenUsed: number): void {
    this.data.tasks.push({
      taskType,
      success,
      durationMs,
      timestamp: new Date().toISOString(),
      tokenUsed,
    });
    // Keep only last 500 tasks
    if (this.data.tasks.length > 500) {
      this.data.tasks = this.data.tasks.slice(-500);
    }
    this.touch();
  }

  // ---------- Parser Metrics ----------

  recordParserUsage(language: string, usedTreeSitter: boolean): void {
    if (usedTreeSitter) {
      this.data.parser.treeSitterFiles++;
    } else {
      this.data.parser.regexFiles++;
    }
    const lang = language || 'unknown';
    if (!this.data.parser.byLanguage[lang]) {
      this.data.parser.byLanguage[lang] = { treeSitter: 0, regex: 0 };
    }
    if (usedTreeSitter) {
      this.data.parser.byLanguage[lang].treeSitter++;
    } else {
      this.data.parser.byLanguage[lang].regex++;
    }
    this.touch();
  }

  // ---------- Graph Metrics ----------

  recordGraphSize(nodeCount: number, edgeCount: number, fileCount: number): void {
    this.data.graph = { nodeCount, edgeCount, fileCount };
    this.touch();
  }

  // ---------- Incremental Savings ----------

  recordIncrementalSavings(filesSkipped: number, filesReanalyzed: number, estimatedTokensSaved: number): void {
    this.data.incrementalSavings.filesSkipped += filesSkipped;
    this.data.incrementalSavings.filesReanalyzed += filesReanalyzed;
    this.data.incrementalSavings.estimatedTokensSaved += estimatedTokensSaved;
    this.touch();
  }

  // ---------- Query ----------

  getSnapshot(): MetricsSnapshot {
    return JSON.parse(JSON.stringify(this.data));
  }

  getAgentMetrics(agentName: string): AgentMetric | undefined {
    const agent = this.data.agents[agentName];
    return agent ? JSON.parse(JSON.stringify(agent)) : undefined;
  }

  getCacheHitRate(): number {
    const total = this.data.cache.hits + this.data.cache.misses;
    return total > 0 ? this.data.cache.hits / total : 0;
  }

  getCacheSimilarityDistribution(): { min: number; max: number; avg: number; median: number } {
    const scores = this.data.cache.similarityScores;
    if (scores.length === 0) {
      return { min: 0, max: 0, avg: 0, median: 0 };
    }
    const sorted = [...scores].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
    return { min, max, avg, median };
  }

  getTaskSuccessRate(taskType?: TaskMetric['taskType']): number {
    const tasks = taskType
      ? this.data.tasks.filter(t => t.taskType === taskType)
      : this.data.tasks;
    return tasks.length > 0
      ? tasks.filter(t => t.success).length / tasks.length
      : 0;
  }

  getTreeSitterCoverage(): number {
    const total = this.data.parser.treeSitterFiles + this.data.parser.regexFiles;
    return total > 0 ? this.data.parser.treeSitterFiles / total : 0;
  }

  getTotalTokensUsed(): number {
    return Object.values(this.data.tokens).reduce((a, b) => a + b, 0);
  }

  // ---------- Persistence ----------

  async load(): Promise<void> {
    try {
      await access(this.path);
      const raw = await readFile(this.path, 'utf-8');
      const parsed = JSON.parse(raw) as MetricsSnapshot;
      // Merge with defaults for any missing fields (backward compat)
      this.data = { ...this.createEmptySnapshot(), ...parsed };
      logger.info(`Loaded metrics from ${this.path}`);
    } catch {
      logger.info(`No existing metrics found at ${this.path}, starting fresh`);
    }
  }

  async flush(): Promise<void> {
    try {
      await writeFile(this.path, JSON.stringify(this.data, null, 2));
    } catch (err) {
      logger.error('Failed to flush metrics:', err);
    }
  }

  async reset(): Promise<void> {
    this.data = this.createEmptySnapshot();
    await this.flush();
    logger.info('Metrics reset');
  }

  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ---------- Internal ----------

  private getOrCreateAgent(name: string): AgentMetric {
    if (!this.data.agents[name]) {
      this.data.agents[name] = {
        agentName: name,
        callCount: 0,
        totalDurationMs: 0,
        successCount: 0,
        failureCount: 0,
      };
    }
    return this.data.agents[name];
  }

  private touch(): void {
    this.data.lastUpdatedAt = new Date().toISOString();
  }

  private createEmptySnapshot(): MetricsSnapshot {
    return {
      version: 1,
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      agents: {},
      cache: {
        totalQueries: 0,
        hits: 0,
        misses: 0,
        similarityScores: [],
      },
      tokens: { analysis: 0, search: 0, planning: 0, review: 0 },
      tasks: [],
      parser: {
        treeSitterFiles: 0,
        regexFiles: 0,
        byLanguage: {},
      },
      graph: {
        nodeCount: 0,
        edgeCount: 0,
        fileCount: 0,
      },
      incrementalSavings: {
        filesSkipped: 0,
        filesReanalyzed: 0,
        estimatedTokensSaved: 0,
      },
    };
  }
}
