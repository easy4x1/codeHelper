import { join } from 'path';
import { homedir } from 'os';
import { readFileSync, existsSync } from 'fs';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('llm-config');

/** Supported LLM providers. */
export type LlmProvider =
  | 'anthropic'
  | 'openai'
  | 'moonshot'
  | 'deepseek'
  | 'zhipu'
  | 'template';

export interface LlmProviderConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

/** Map user-facing aliases to canonical provider names. */
const PROVIDER_ALIASES: Record<string, LlmProvider> = {
  anthropic: 'anthropic',
  openai: 'openai',
  moonshot: 'moonshot',
  kimi: 'moonshot',
  deepseek: 'deepseek',
  zhipu: 'zhipu',
  glm: 'zhipu',
  template: 'template',
};

/** Default model per provider. */
const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: 'claude-sonnet-4-6-20251001',
  openai: 'gpt-5.4',
  moonshot: 'kimi-k2.5',
  deepseek: 'deepseek-chat',
  zhipu: 'glm-5.1',
  template: 'template',
};

/** Environment variable names per provider (ordered by priority). */
const ENV_KEY_NAMES: Record<LlmProvider, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  zhipu: ['ZHIPU_API_KEY', 'GLM_API_KEY'],
  template: [],
};

// ============================================
// API Key Security Utilities
// ============================================

/** Mask an API key for safe logging: sk-ant-... → sk-a****xxxx */
export function maskApiKey(key: string): string {
  if (!key || key.length <= 10) return '*'.repeat(key?.length ?? 4);
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/**
 * Recursively sanitize an object for logging:
 * - Replaces API keys with masked versions
 * - Masks fields named apiKey, token, secret, password
 */
export function sanitizeForLogging(obj: unknown): unknown {
  if (typeof obj !== 'object' || obj === null) {
    if (typeof obj === 'string') {
      return obj
        .replace(/\b(sk-ant-api\d{2}-[a-zA-Z0-9_-]{30,})\b/g, (m) => maskApiKey(m))
        .replace(/\b(sk-[a-zA-Z0-9]{40,})\b/g, (m) => maskApiKey(m))
        .replace(/\b([a-f0-9]{32,})\b/g, (m) => (m.length >= 40 ? maskApiKey(m) : m));
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeForLogging);
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/api_?key|token|secret|password/i.test(k)) {
      result[k] = typeof v === 'string' ? maskApiKey(v) : v;
    } else {
      result[k] = sanitizeForLogging(v);
    }
  }
  return result;
}

// ============================================
// Config Resolver
// ============================================

export interface ResolvedConfig {
  config: LlmProviderConfig;
  source: 'environment' | 'user-config' | 'fallback';
}

export class LlmConfigResolver {
  private userConfigPath = join(homedir(), '.code-agent', 'config.yaml');

  /**
   * Resolve LLM configuration from secure sources.
   *
   * Priority:
   *   1. Explicit provider hint (if given)
   *   2. Auto-detect from environment variables (anthropic → openai → moonshot → deepseek → zhipu)
   *   3. ~/.code-agent/config.yaml
   *   4. Template fallback (no API key needed)
   */
  resolve(providerHint?: string, modelHint?: string): ResolvedConfig | null {
    const provider = this.normalizeProvider(providerHint);

    // If no hint given, auto-detect available API keys
    if (!providerHint) {
      const detected = this.autoDetectProvider();
      if (detected) {
        logger.info(`Auto-detected ${detected.provider} API key from environment`);
        return {
          config: this.buildConfig(detected.provider, detected.key, modelHint),
          source: 'environment',
        };
      }
      // No API key found anywhere — use template fallback
      return {
        config: { provider: 'template', model: 'template', apiKey: '' },
        source: 'fallback',
      };
    }

    if (provider === 'template') {
      return {
        config: { provider: 'template', model: 'template', apiKey: '' },
        source: 'fallback',
      };
    }

    // ① Environment variables
    const envKey = this.getEnvKey(provider);
    if (envKey) {
      logger.info(`Using ${provider} API key from environment`);
      return {
        config: this.buildConfig(provider, envKey, modelHint),
        source: 'environment',
      };
    }

    // ② User config file
    const userKey = this.readUserConfig(provider);
    if (userKey) {
      logger.info(`Using ${provider} API key from user config`);
      return {
        config: this.buildConfig(provider, userKey, modelHint),
        source: 'user-config',
      };
    }

    // No key found — caller should fall back to TemplateLlmService
    logger.warn(
      `No API key found for ${provider}. ` +
        `Set ${ENV_KEY_NAMES[provider].join(' or ')} environment variable, ` +
        `or run "code-agent configure --provider ${provider}"`
    );
    return null;
  }

  private normalizeProvider(hint?: string): LlmProvider {
    if (!hint) return 'template';
    const canonical = PROVIDER_ALIASES[hint.toLowerCase()];
    return canonical ?? 'template';
  }

  /** Auto-detect available provider from environment variables. */
  private autoDetectProvider(): { provider: LlmProvider; key: string } | undefined {
    const priority: LlmProvider[] = ['anthropic', 'openai', 'moonshot', 'deepseek', 'zhipu'];
    for (const provider of priority) {
      const key = this.getEnvKey(provider);
      if (key) return { provider, key };
    }
    return undefined;
  }

  private getEnvKey(provider: LlmProvider): string | undefined {
    const names = ENV_KEY_NAMES[provider];
    for (const name of names) {
      const value = process.env[name];
      if (value?.trim()) return value.trim();
    }
    return undefined;
  }

  private readUserConfig(provider: LlmProvider): string | undefined {
    try {
      if (!existsSync(this.userConfigPath)) return undefined;
      const content = readFileSync(this.userConfigPath, 'utf-8');
      // Naive YAML parser: match provider block → apiKey field
      const blockRegex = new RegExp(
        `^${provider}:\\s*$\\n((?:\\s+\\S+:.+\\n?)*)`,
        'im'
      );
      const blockMatch = content.match(blockRegex);
      if (!blockMatch) return undefined;

      const keyRegex = /^\s+apiKey:\s*(.+)$/im;
      const keyMatch = blockMatch[1].match(keyRegex);
      return keyMatch?.[1]?.trim();
    } catch {
      return undefined;
    }
  }

  /** Environment variable names for base URLs per provider. */
  private getBaseUrl(provider: LlmProvider): string | undefined {
    const envMap: Record<LlmProvider, string | undefined> = {
      anthropic: process.env.ANTHROPIC_BASE_URL,
      openai: process.env.OPENAI_BASE_URL,
      moonshot: process.env.MOONSHOT_BASE_URL,
      deepseek: process.env.DEEPSEEK_BASE_URL,
      zhipu: process.env.ZHIPU_BASE_URL,
      template: undefined,
    };
    return envMap[provider]?.trim();
  }

  private buildConfig(
    provider: LlmProvider,
    apiKey: string,
    model?: string
  ): LlmProviderConfig {
    return {
      provider,
      model: model ?? DEFAULT_MODELS[provider],
      apiKey,
      baseUrl: this.getBaseUrl(provider),
    };
  }
}
