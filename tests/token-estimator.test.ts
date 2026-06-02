import { describe, it, expect, vi } from 'vitest';
import {
  ModelAwareTokenEstimator,
  estimateTokensRough,
  type TokenEstimator,
} from '../src/core/token-estimator.js';

describe('ModelAwareTokenEstimator', () => {
  it('estimates English text with default ratio', () => {
    const estimator = new ModelAwareTokenEstimator('claude-sonnet-4-6');
    const text = 'function greet() { return "hello"; }';
    const tokens = estimator.estimate(text);
    // 36 chars / 3.8 ≈ 10 tokens
    expect(tokens).toBeGreaterThanOrEqual(9);
    expect(tokens).toBeLessThanOrEqual(12);
  });

  it('estimates Chinese text with higher token count', () => {
    const estimator = new ModelAwareTokenEstimator('claude-sonnet-4-6');
    const text = '这是一个中文测试字符串，用于验证分词器的效果。';
    const tokens = estimator.estimate(text);
    // Chinese chars are denser in tokens: ratio ~3.8 * 0.5 = 1.9
    expect(tokens).toBeGreaterThan(text.length / 2); // significantly more tokens
  });

  it('returns higher tokens for domestic models on same text', () => {
    const english = 'function example() { console.log("test"); }';

    const claude = new ModelAwareTokenEstimator('claude-sonnet-4-6');
    const kimi = new ModelAwareTokenEstimator('kimi-k2.5');
    const glm = new ModelAwareTokenEstimator('glm-5.1');

    const claudeTokens = claude.estimate(english);
    const kimiTokens = kimi.estimate(english);
    const glmTokens = glm.estimate(english);

    // Domestic models have lower ratios = more tokens per char
    expect(kimiTokens).toBeGreaterThanOrEqual(claudeTokens);
    expect(glmTokens).toBeGreaterThanOrEqual(kimiTokens);
  });

  it('matches known model families', () => {
    const cases: Array<{ model: string; expectedLabel: string; expectedRatio: number }> = [
      { model: 'claude-sonnet-4-6', expectedLabel: 'Claude', expectedRatio: 3.8 },
      { model: 'gpt-5.4', expectedLabel: 'GPT-5.4', expectedRatio: 3.5 },
      { model: 'gpt-5.5', expectedLabel: 'GPT-5.5', expectedRatio: 3.4 },
      { model: 'gpt-4.5-turbo', expectedLabel: 'GPT-4.5', expectedRatio: 4.0 },
      { model: 'gpt-4o', expectedLabel: 'GPT-4o', expectedRatio: 4.2 },
      { model: 'kimi-k2.5', expectedLabel: 'Kimi K2', expectedRatio: 2.6 },
      { model: 'kimi-k2.6', expectedLabel: 'Kimi K2', expectedRatio: 2.6 },
      { model: 'deepseek-chat', expectedLabel: 'DeepSeek', expectedRatio: 2.8 },
      { model: 'glm-5.1', expectedLabel: 'GLM-5.1', expectedRatio: 2.5 },
    ];

    for (const c of cases) {
      const estimator = new ModelAwareTokenEstimator(c.model);
      const info = estimator.getModelInfo();
      expect(info.label).toBe(c.expectedLabel);
      expect(info.ratio).toBe(c.expectedRatio);
    }
  });

  it('falls back to default for unknown models', () => {
    const estimator = new ModelAwareTokenEstimator('some-unknown-model-v99');
    const info = estimator.getModelInfo();
    expect(info.label).toBe('default');
    expect(info.ratio).toBe(4.0);
  });

  it('warns once for deprecated models', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const estimator = new ModelAwareTokenEstimator('gpt-4.5-turbo');

    // First call triggers warning
    estimator.estimate('hello');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('deprecated')
    );

    // Second call does not warn again
    estimator.estimate('world');
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('returns at least 1 token for empty string', () => {
    const estimator = new ModelAwareTokenEstimator('claude-sonnet-4-6');
    expect(estimator.estimate('')).toBe(1);
  });

  it('handles mixed Chinese-English text', () => {
    const estimator = new ModelAwareTokenEstimator('glm-5.1');
    // 50% Chinese, 50% English
    const text = 'function测试代码test';
    const tokens = estimator.estimate(text);
    // Should be between pure-English and pure-Chinese estimates
    const pureEnglishTokens = estimator.estimate('functiontest');
    expect(tokens).toBeGreaterThanOrEqual(pureEnglishTokens);
  });
});

describe('estimateTokensRough', () => {
  it('uses fixed 1:4 ratio', () => {
    expect(estimateTokensRough('abcd')).toBe(1);
    expect(estimateTokensRough('abcdefghijklmnop')).toBe(4);
    expect(estimateTokensRough('')).toBe(0);
  });
});
