import type { FaultPattern, FixPattern, Convention } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('recommendation-engine');

export interface Recommendation {
  type: 'fault' | 'fix' | 'convention';
  title: string;
  description: string;
  score: number; // 0-1 similarity
  evidence?: string;
}

/**
 * Recommend relevant patterns and conventions based on the current problem description.
 *
 * Uses keyword overlap scoring. Phase 2 (future): semantic embedding similarity.
 */
export class RecommendationEngine {
  recommend(
    problemDescription: string,
    faultPatterns: FaultPattern[],
    fixPatterns: FixPattern[],
    conventions: Convention[]
  ): Recommendation[] {
    const recommendations: Recommendation[] = [];
    const problemWords = this.tokenize(problemDescription);

    // Score fault patterns
    for (const pattern of faultPatterns) {
      const score = this.computeSimilarity(problemWords, this.tokenize(pattern.pattern));
      if (score > 0.1) {
        recommendations.push({
          type: 'fault',
          title: `Historical: ${pattern.pattern}`,
          description: `Found ${pattern.frequency} time(s) in past tasks`,
          score: score * Math.min(1, pattern.frequency * 0.2),
          evidence: pattern.language ? `Language: ${pattern.language}` : undefined,
        });
      }
    }

    // Score fix patterns
    for (const pattern of fixPatterns) {
      const score = this.computeSimilarity(problemWords, this.tokenize(pattern.pattern));
      if (score > 0.1) {
        recommendations.push({
          type: 'fix',
          title: `Suggested fix: ${pattern.pattern}`,
          description: `Applied ${pattern.frequency} time(s) successfully`,
          score: score * Math.min(1, pattern.frequency * 0.2),
        });
      }
    }

    // Score conventions
    for (const convention of conventions) {
      const conventionWords = this.tokenize(`${convention.rule} ${convention.category}`);
      const score = this.computeSimilarity(problemWords, conventionWords);
      if (score > 0.1) {
        recommendations.push({
          type: 'convention',
          title: `Convention: ${convention.rule}`,
          description: `Examples: ${convention.examples.join(', ')}`,
          score: score * convention.confidence,
        });
      }
    }

    // Sort by score descending
    recommendations.sort((a, b) => b.score - a.score);

    logger.info(`Generated ${recommendations.length} recommendation(s) for "${problemDescription}"`);
    return recommendations.slice(0, 5); // Top 5
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
      .filter(w => !this.stopWords.includes(w));
  }

  private computeSimilarity(wordsA: string[], wordsB: string[]): number {
    const setA = new Set(wordsA);
    const setB = new Set(wordsB);

    const intersection = [...setA].filter(w => setB.has(w));
    const union = new Set([...setA, ...setB]);

    return union.size > 0 ? intersection.length / union.size : 0;
  }

  private stopWords = [
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our',
    'fix', 'add', 'remove', 'update', 'change', 'this', 'that', 'with', 'from', 'have', 'has', 'been',
  ];
}
