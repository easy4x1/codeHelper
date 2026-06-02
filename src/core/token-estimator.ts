/**
 * Model-aware token estimator.
 *
 * Different tokenizers have vastly different chars-per-token ratios.
 * Domestic models (Kimi, DeepSeek, GLM) use Chinese-optimized tokenizers
 * with lower ratios (more tokens per character for CJK text).
 *
 * Ratio reference (chars / token):
 * - Lower ratio  = more tokens for same text (CJK-optimized)
 * - Higher ratio = fewer tokens for same text (English-optimized)
 */
export interface TokenEstimator {
  estimate(text: string): number;
}

interface ModelMatch {
  label: string;
  ratio: number;
  deprecated?: boolean;
  deprecatedMessage?: string;
}

export class ModelAwareTokenEstimator implements TokenEstimator {
  // Ordered by specificity — more specific patterns first
  private static readonly ENTRIES: Array<{
    pattern: RegExp;
    ratio: number;
    label: string;
    deprecated?: boolean;
    deprecatedMessage?: string;
  }> = [
    // ─── 国产模型：中文优化 tokenizer ───
    { pattern: /^glm-5\.1/i, ratio: 2.5, label: 'GLM-5.1' },
    { pattern: /^glm-/i, ratio: 2.6, label: 'GLM' },
    { pattern: /^kimi-k2\.[56]/i, ratio: 2.6, label: 'Kimi K2' },
    { pattern: /^kimi-/i, ratio: 2.7, label: 'Kimi' },
    { pattern: /^deepseek-/i, ratio: 2.8, label: 'DeepSeek' },
    { pattern: /^deepseek$/i, ratio: 2.8, label: 'DeepSeek' },

    // ─── OpenAI GPT 5.x 系列（新 tokenizer，效率提升）───
    { pattern: /^gpt-5\.5/i, ratio: 3.4, label: 'GPT-5.5' },
    { pattern: /^gpt-5\.4/i, ratio: 3.5, label: 'GPT-5.4' },
    { pattern: /^gpt-5/i, ratio: 3.6, label: 'GPT-5' },

    // ─── OpenAI GPT 4.x 系列 ───
    {
      pattern: /^gpt-4\.5/i,
      ratio: 4.0,
      label: 'GPT-4.5',
      deprecated: true,
      deprecatedMessage:
        'GPT-4.5 is deprecated and scheduled for removal. Migrate to GPT-5.4 or GPT-5.5.',
    },
    { pattern: /^gpt-4o/i, ratio: 4.2, label: 'GPT-4o' },
    { pattern: /^gpt-4/i, ratio: 4.0, label: 'GPT-4' },
    { pattern: /^gpt-3\.5/i, ratio: 4.2, label: 'GPT-3.5' },

    // ─── Anthropic Claude ───
    { pattern: /^claude-/i, ratio: 3.8, label: 'Claude' },

    // ─── Fallback ───
    { pattern: /.*/, ratio: 4.0, label: 'default' },
  ];

  private warnedDeprecated = false;

  constructor(private model: string = 'default') {}

  estimate(text: string): number {
    const match = this.resolveModel();

    if (match.deprecated && !this.warnedDeprecated) {
      this.warnedDeprecated = true;
      console.warn(
        `[token-estimator] ${match.deprecatedMessage ?? `Model "${this.model}" (${match.label}) is deprecated.`}`
      );
    }

    const baseRatio = match.ratio;
    const chineseRatio = detectChineseRatio(text);

    // Adaptive adjustment:
    // - Pure Chinese (ratio=1): effective ratio = base * 0.5  → ~2x tokens vs English
    // - Pure English (ratio=0): effective ratio = base * 1.0  → unchanged
    const adjusted = baseRatio * (1 - chineseRatio * 0.5);

    return Math.max(1, Math.ceil(text.length / Math.max(1.0, adjusted)));
  }

  getModelInfo(): ModelMatch {
    return this.resolveModel();
  }

  private resolveModel(): ModelMatch {
    for (const entry of ModelAwareTokenEstimator.ENTRIES) {
      if (entry.pattern.test(this.model)) {
        return {
          label: entry.label,
          ratio: entry.ratio,
          deprecated: entry.deprecated,
          deprecatedMessage: entry.deprecatedMessage,
        };
      }
    }
    return { label: 'default', ratio: 4.0 };
  }
}

/** Detect CJK (Chinese/Japanese/Korean) character ratio in text. */
function detectChineseRatio(text: string): number {
  if (text.length === 0) return 0;
  // CJK Unified Ideographs + CJK Extension A + CJK Unified Ideographs Extension B-F
  const cjk = text.match(/[一-鿿㐀-䶿]/gu);
  return cjk ? cjk.length / text.length : 0;
}

/** Backward-compatible static estimator (uses default ratio). */
export function estimateTokensRough(text: string): number {
  return Math.ceil(text.length / 4);
}
