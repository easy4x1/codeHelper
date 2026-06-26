import type { LlmSemanticCacheEntry } from './types.js';

/**
 * Cache for D-layer LLM semantic results.
 *
 * Keys are structured as `<enricher>:<nodeOrClusterId>:<contentHash>` so that
 * unchanged files/clusters reuse previous LLM outputs across init/sync runs.
 */
export class LlmSemanticCache {
  private entries = new Map<string, LlmSemanticCacheEntry>();

  constructor(initial: LlmSemanticCacheEntry[] = []) {
    for (const entry of initial) {
      this.entries.set(entry.key, entry);
    }
  }

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    try {
      return entry.result as T;
    } catch {
      return undefined;
    }
  }

  set<T>(key: string, result: T): void {
    this.entries.set(key, {
      key,
      result,
      timestamp: new Date().toISOString(),
    });
  }

  export(): LlmSemanticCacheEntry[] {
    return Array.from(this.entries.values());
  }
}
