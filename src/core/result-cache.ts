import type { Finding, ResultCacheEntry } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('result-cache');

interface CacheEntry {
  findings: Finding[];
  timestamp: string;
}

/**
 * ResultCache — caches analysis results keyed by file path + content hash.
 *
 * When a file's fingerprint (content hash) hasn't changed, re-analysis can be
 * skipped and cached findings returned directly. This achieves 80%+ token
 * savings for unchanged files.
 *
 * Entries are persisted via MemoryMiddleware (export/load) so the cache survives
 * across CLI invocations, not just within a single process. Growth is bounded by
 * an LRU policy (`maxEntries`): the least-recently-used entry is evicted once the
 * cap is exceeded, so repeated edits to the same files never grow the cache
 * without bound. The backing Map is insertion-ordered, so "oldest key" = LRU;
 * a cache hit re-inserts its key to mark it most-recently-used.
 */
export class ResultCache {
  private store = new Map<string, CacheEntry>();
  private readonly maxEntries: number;

  constructor(options?: { maxEntries?: number }) {
    this.maxEntries = options?.maxEntries ?? 500;
  }

  /**
   * Retrieve cached findings for a file if the content hash matches.
   * A hit refreshes the entry's recency (LRU bump).
   */
  get(filePath: string, contentHash: string): Finding[] | undefined {
    const key = this.makeKey(filePath, contentHash);
    const entry = this.store.get(key);
    if (entry) {
      // LRU bump: re-insert to move this key to the most-recent position.
      this.store.delete(key);
      this.store.set(key, entry);
      logger.info(`Cache HIT for ${filePath} (${contentHash.slice(0, 8)}…)`);
      return JSON.parse(JSON.stringify(entry.findings));
    }
    logger.info(`Cache MISS for ${filePath} (${contentHash.slice(0, 8)}…)`);
    return undefined;
  }

  /**
   * Store findings for a file keyed by its content hash, evicting the
   * least-recently-used entry if the cap is exceeded.
   */
  set(filePath: string, contentHash: string, findings: Finding[]): void {
    const key = this.makeKey(filePath, contentHash);
    // Delete first so a re-set moves the key to the most-recent position.
    this.store.delete(key);
    this.store.set(key, {
      findings: JSON.parse(JSON.stringify(findings)),
      timestamp: new Date().toISOString(),
    });
    this.evictToCap();
    logger.info(`Cached ${findings.length} finding(s) for ${filePath}`);
  }

  /** Export entries for persistence (deep-copied, oldest-first). */
  export(): ResultCacheEntry[] {
    const entries: ResultCacheEntry[] = [];
    for (const [key, entry] of this.store) {
      entries.push({ key, findings: entry.findings, timestamp: entry.timestamp });
    }
    return JSON.parse(JSON.stringify(entries));
  }

  /** Replace entries from persisted storage (deep-copied, capped). */
  load(entries: ResultCacheEntry[] | undefined): void {
    this.store.clear();
    if (!entries) return;
    for (const e of entries) {
      this.store.set(e.key, {
        findings: JSON.parse(JSON.stringify(e.findings)),
        timestamp: e.timestamp,
      });
    }
    this.evictToCap();
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.store.clear();
    logger.info('Result cache cleared');
  }

  /**
   * Return number of cached entries.
   */
  size(): number {
    return this.store.size;
  }

  /** Drop least-recently-used entries until within the cap. */
  private evictToCap(): void {
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
      logger.info(`Evicted LRU cache entry: ${oldestKey}`);
    }
  }

  private makeKey(filePath: string, contentHash: string): string {
    return `${filePath}::${contentHash}`;
  }
}
