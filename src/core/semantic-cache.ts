import type { SolutionPlan } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('semantic-cache');

interface SemanticCacheEntry {
  keywords: string[];
  plan: SolutionPlan;
  timestamp: string;
}

/**
 * SemanticCache — caches SolutionPlans keyed by task description keywords.
 *
 * Uses Jaccard similarity over keyword sets (no vector embeddings required).
 * When a new task is sufficiently similar (> threshold) to a cached task,
 * the cached plan is returned directly, saving analysis + planning tokens.
 *
 * Expected savings: 60-80% for recurring problem types.
 */
export class SemanticCache {
  private entries: SemanticCacheEntry[] = [];
  private readonly defaultThreshold = 0.5;

  /**
   * Find a cached plan whose keywords have Jaccard similarity >= threshold
   * with the query keywords.
   */
  findSimilar(query: string, threshold = this.defaultThreshold): SolutionPlan | undefined {
    const queryKeywords = this.tokenize(query);
    if (queryKeywords.length === 0) return undefined;

    let bestMatch: SemanticCacheEntry | undefined;
    let bestScore = 0;

    for (const entry of this.entries) {
      const score = this.jaccardSimilarity(queryKeywords, entry.keywords);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = entry;
      }
    }

    if (bestMatch && bestScore >= threshold) {
      logger.info(`Semantic cache HIT (score=${bestScore.toFixed(2)}): "${query.slice(0, 40)}…"`);
      return JSON.parse(JSON.stringify(bestMatch.plan));
    }

    logger.info(`Semantic cache MISS (best score=${bestScore.toFixed(2)}): "${query.slice(0, 40)}…"`);
    return undefined;
  }

  /**
   * Store a plan keyed by the task description.
   */
  store(query: string, plan: SolutionPlan): void {
    const keywords = this.tokenize(query);
    this.entries.push({
      keywords,
      plan: JSON.parse(JSON.stringify(plan)),
      timestamp: new Date().toISOString(),
    });
    logger.info(`Stored plan ${plan.id} with ${keywords.length} keyword(s)`);
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.entries = [];
    logger.info('Semantic cache cleared');
  }

  /**
   * Return number of cached entries.
   */
  size(): number {
    return this.entries.length;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
      .filter(w => !this.stopWords.has(w));
  }

  private jaccardSimilarity(a: string[], b: string[]): number {
    const setA = new Set(a);
    const setB = new Set(b);
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  private stopWords = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our',
    'this', 'that', 'with', 'from', 'have', 'has', 'been', 'will', 'would', 'should', 'could',
    'fix', 'add', 'remove', 'update', 'change', 'into', 'than', 'only', 'some', 'time', 'very',
  ]);
}
