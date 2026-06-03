import type {
  TokenBudgetConfig,
  TokenBudgetStatus,
  DegradationLevel,
  BudgetRecommendations,
} from './types.js';
import { createLogger } from '../utils/logger.js';
import { ModelAwareTokenEstimator, type TokenEstimator } from './token-estimator.js';

export const DEFAULT_CONFIG: TokenBudgetConfig = {
  total: 50000,
  allocated: {
    analysis: 20000,
    search: 10000,
    planning: 15000,
    review: 5000,
  },
};

interface Threshold {
  fraction: number;
  level: DegradationLevel;
}

const DEGRADATION_THRESHOLDS: Threshold[] = [
  { fraction: 0.95, level: 'prompt_user' },
  { fraction: 0.90, level: 'core_only' },
  { fraction: 0.80, level: 'disable_search' },
  { fraction: 0.70, level: 'reduce_depth' },
];

export class TokenBudgetManager {
  private config: TokenBudgetConfig;
  private usageByCategory: {
    analysis: number;
    search: number;
    planning: number;
    review: number;
  };
  private logger = createLogger('token-budget');
  private estimator: TokenEstimator;

  constructor(config?: TokenBudgetConfig, estimator?: TokenEstimator) {
    this.config = config ?? DEFAULT_CONFIG;
    this.estimator = estimator ?? new ModelAwareTokenEstimator();
    this.usageByCategory = {
      analysis: 0,
      search: 0,
      planning: 0,
      review: 0,
    };
  }

  recordUsage(category: keyof TokenBudgetConfig['allocated'], tokens: number): void {
    const safeTokens = Math.max(0, tokens);
    const newUsage = this.usageByCategory[category] + safeTokens;
    const limit = this.config.allocated[category];

    if (newUsage > limit) {
      this.logger.warn(
        `${category} token usage (${newUsage}) exceeds allocated limit (${limit})`
      );
    }

    this.usageByCategory[category] = newUsage;
  }

  getStatus(): TokenBudgetStatus {
    const used = Object.values(this.usageByCategory).reduce((sum, v) => sum + v, 0);
    const remaining = Math.max(0, this.config.total - used);
    return {
      total: this.config.total,
      allocated: { ...this.config.allocated },
      used,
      remaining,
      usageByCategory: { ...this.usageByCategory },
    };
  }

  checkDegradation(): BudgetRecommendations {
    const status = this.getStatus();
    const usedFraction = status.used / status.total;
    const remainingPercent = Math.round((status.remaining / status.total) * 100);

    let level: DegradationLevel = 'none';
    for (const threshold of DEGRADATION_THRESHOLDS) {
      if (usedFraction >= threshold.fraction) {
        level = threshold.level;
        break;
      }
    }

    return this.buildRecommendations(level, remainingPercent);
  }

  getRecommendations(): BudgetRecommendations {
    return this.checkDegradation();
  }

  hasBudgetFor(category: keyof TokenBudgetConfig['allocated'], estimatedTokens: number): boolean {
    const status = this.getStatus();
    const categoryUsed = this.usageByCategory[category];
    const categoryRemaining = this.config.allocated[category] - categoryUsed;
    return estimatedTokens <= categoryRemaining && estimatedTokens <= status.remaining;
  }

  estimateTokens(text: string): number {
    return this.estimator.estimate(text);
  }

  /** Restore budget state from a serialized snapshot (e.g., loaded from MemoryMiddleware). */
  restoreSnapshot(status: TokenBudgetStatus): void {
    this.config = {
      total: status.total,
      allocated: { ...status.allocated },
    };
    this.usageByCategory = { ...status.usageByCategory };
    this.logger.info('Token budget restored from snapshot');
  }

  /** Backward-compatible static method (uses rough 1:4 estimate). */
  static estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private buildRecommendations(level: DegradationLevel, remainingPercent: number): BudgetRecommendations {
    switch (level) {
      case 'prompt_user':
        return {
          level,
          shouldProceed: false,
          adjustments: {
            maxPropagationDepth: 0,
            maxFilesToAnalyze: 0,
            enableWebSearch: false,
            enableDetailedAnalysis: false,
          },
          message: `Token budget exhausted: ${remainingPercent}% remaining. Please review or increase budget.`,
        };
      case 'core_only':
        return {
          level,
          shouldProceed: true,
          adjustments: {
            maxPropagationDepth: 1,
            maxFilesToAnalyze: 3,
            enableWebSearch: false,
            enableDetailedAnalysis: false,
          },
          message: `Token budget critical: ${remainingPercent}% remaining. Core-only analysis mode.`,
        };
      case 'disable_search':
        return {
          level,
          shouldProceed: true,
          adjustments: {
            maxPropagationDepth: 2,
            enableWebSearch: false,
            enableDetailedAnalysis: true,
          },
          message: `Token budget warning: ${remainingPercent}% remaining. Disabling web search.`,
        };
      case 'reduce_depth':
        return {
          level,
          shouldProceed: true,
          adjustments: {
            maxPropagationDepth: 2,
            enableWebSearch: true,
            enableDetailedAnalysis: true,
          },
          message: `Token budget caution: ${remainingPercent}% remaining. Reducing analysis depth.`,
        };
      case 'none':
      default:
        return {
          level: 'none',
          shouldProceed: true,
          adjustments: {
            maxPropagationDepth: 3,
            enableWebSearch: true,
            enableDetailedAnalysis: true,
          },
          message: `Token budget healthy: ${remainingPercent}% remaining`,
        };
    }
  }
}
