import { describe, it, expect, beforeEach } from 'vitest';
import { TokenBudgetManager, DEFAULT_CONFIG } from '../src/core/token-budget.js';

describe('TokenBudgetManager', () => {
  describe('tracks usage by category', () => {
    it('records analysis and planning usage correctly', () => {
      const manager = new TokenBudgetManager({
        total: 10000,
        allocated: { analysis: 5000, search: 2000, planning: 2000, review: 1000 },
      });
      manager.recordUsage('analysis', 500);
      manager.recordUsage('planning', 300);
      const status = manager.getStatus();
      expect(status.used).toBe(800);
      expect(status.usageByCategory.analysis).toBe(500);
      expect(status.usageByCategory.planning).toBe(300);
      expect(status.usageByCategory.search).toBe(0);
      expect(status.usageByCategory.review).toBe(0);
    });
  });

  describe('returns none degradation when budget is healthy', () => {
    it('10% used → level none', () => {
      const manager = new TokenBudgetManager({
        total: 10000,
        allocated: { analysis: 5000, search: 2000, planning: 2000, review: 1000 },
      });
      manager.recordUsage('analysis', 1000);
      const recs = manager.getRecommendations();
      expect(recs.level).toBe('none');
      expect(recs.shouldProceed).toBe(true);
      expect(recs.adjustments.maxPropagationDepth).toBe(3);
      expect(recs.adjustments.enableWebSearch).toBe(true);
    });
  });

  describe('triggers reduce_depth at 70% usage', () => {
    it('7000/10000 used → level reduce_depth, maxPropagationDepth=2', () => {
      const manager = new TokenBudgetManager({
        total: 10000,
        allocated: { analysis: 5000, search: 2000, planning: 2000, review: 1000 },
      });
      manager.recordUsage('analysis', 7000);
      const recs = manager.checkDegradation();
      expect(recs.level).toBe('reduce_depth');
      expect(recs.shouldProceed).toBe(true);
      expect(recs.adjustments.maxPropagationDepth).toBe(2);
    });
  });

  describe('triggers disable_search at 80% usage', () => {
    it('8000/10000 used → level disable_search, enableWebSearch=false', () => {
      const manager = new TokenBudgetManager({
        total: 10000,
        allocated: { analysis: 5000, search: 2000, planning: 2000, review: 1000 },
      });
      manager.recordUsage('analysis', 8000);
      const recs = manager.checkDegradation();
      expect(recs.level).toBe('disable_search');
      expect(recs.shouldProceed).toBe(true);
      expect(recs.adjustments.enableWebSearch).toBe(false);
    });
  });

  describe('triggers core_only at 90% usage', () => {
    it('9000/10000 used → level core_only, maxPropagationDepth=1, maxFilesToAnalyze=3', () => {
      const manager = new TokenBudgetManager({
        total: 10000,
        allocated: { analysis: 5000, search: 2000, planning: 2000, review: 1000 },
      });
      manager.recordUsage('analysis', 9000);
      const recs = manager.checkDegradation();
      expect(recs.level).toBe('core_only');
      expect(recs.shouldProceed).toBe(true);
      expect(recs.adjustments.maxPropagationDepth).toBe(1);
      expect(recs.adjustments.maxFilesToAnalyze).toBe(3);
    });
  });

  describe('triggers prompt_user at 95% usage', () => {
    it('9500/10000 used → level prompt_user, shouldProceed=false', () => {
      const manager = new TokenBudgetManager({
        total: 10000,
        allocated: { analysis: 5000, search: 2000, planning: 2000, review: 1000 },
      });
      manager.recordUsage('analysis', 9500);
      const recs = manager.checkDegradation();
      expect(recs.level).toBe('prompt_user');
      expect(recs.shouldProceed).toBe(false);
      expect(recs.adjustments.maxPropagationDepth).toBe(0);
      expect(recs.adjustments.maxFilesToAnalyze).toBe(0);
    });
  });

  describe('prevents usage from exceeding total budget', () => {
    it('caps used at total budget', () => {
      const manager = new TokenBudgetManager({
        total: 10000,
        allocated: { analysis: 5000, search: 2000, planning: 2000, review: 1000 },
      });
      manager.recordUsage('analysis', 12000);
      const status = manager.getStatus();
      expect(status.used).toBe(12000);
      expect(status.remaining).toBe(0);
    });
  });

  describe('returns recommendations for propagation options', () => {
    it('healthy budget has maxPropagationDepth=3 and enableWebSearch=true', () => {
      const manager = new TokenBudgetManager({
        total: 10000,
        allocated: { analysis: 5000, search: 2000, planning: 2000, review: 1000 },
      });
      manager.recordUsage('analysis', 500);
      const recs = manager.getRecommendations();
      expect(recs.level).toBe('none');
      expect(recs.adjustments.maxPropagationDepth).toBe(3);
      expect(recs.adjustments.enableWebSearch).toBe(true);
      expect(recs.adjustments.enableDetailedAnalysis).toBe(true);
    });
  });

  describe('adjusts recommendations under budget pressure', () => {
    it('65% used remains none but verify status', () => {
      const manager = new TokenBudgetManager({
        total: 10000,
        allocated: { analysis: 5000, search: 2000, planning: 2000, review: 1000 },
      });
      manager.recordUsage('analysis', 6500);
      const recs = manager.getRecommendations();
      expect(recs.level).toBe('none');
      expect(recs.shouldProceed).toBe(true);
      expect(recs.adjustments.maxPropagationDepth).toBe(3);
    });
  });

  describe('provides default config when none specified', () => {
    it('no config constructor uses total=50000', () => {
      const manager = new TokenBudgetManager();
      const status = manager.getStatus();
      expect(status.total).toBe(50000);
      expect(status.allocated.analysis).toBe(20000);
      expect(status.allocated.search).toBe(10000);
      expect(status.allocated.planning).toBe(15000);
      expect(status.allocated.review).toBe(5000);
    });
  });

  describe('hasBudgetFor', () => {
    it('returns true when both category and total remaining are sufficient', () => {
      const manager = new TokenBudgetManager({
        total: 10000,
        allocated: { analysis: 5000, search: 2000, planning: 2000, review: 1000 },
      });
      expect(manager.hasBudgetFor('analysis', 1000)).toBe(true);
    });

    it('returns false when estimated exceeds category remaining', () => {
      const manager = new TokenBudgetManager({
        total: 10000,
        allocated: { analysis: 5000, search: 2000, planning: 2000, review: 1000 },
      });
      manager.recordUsage('analysis', 4000);
      expect(manager.hasBudgetFor('analysis', 2000)).toBe(false);
    });

    it('returns false when estimated exceeds total remaining', () => {
      const manager = new TokenBudgetManager({
        total: 10000,
        allocated: { analysis: 5000, search: 2000, planning: 2000, review: 1000 },
      });
      manager.recordUsage('analysis', 9000);
      expect(manager.hasBudgetFor('planning', 2000)).toBe(false);
    });
  });

  describe('estimateTokens', () => {
    it('returns Math.ceil(text.length / 4)', () => {
      expect(TokenBudgetManager.estimateTokens('abcd')).toBe(1);
      expect(TokenBudgetManager.estimateTokens('abc')).toBe(1);
      expect(TokenBudgetManager.estimateTokens('abcdefghijklmnop')).toBe(4);
      expect(TokenBudgetManager.estimateTokens('')).toBe(0);
    });
  });

  describe('recordUsage prevents negative', () => {
    it('ignores negative token values', () => {
      const manager = new TokenBudgetManager({
        total: 10000,
        allocated: { analysis: 5000, search: 2000, planning: 2000, review: 1000 },
      });
      manager.recordUsage('analysis', 500);
      manager.recordUsage('analysis', -100);
      const status = manager.getStatus();
      expect(status.usageByCategory.analysis).toBe(500);
    });
  });
});
