import type { Finding, SolutionPlan, FaultPattern, FixPattern } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('pattern-extractor');

/**
 * Extract reusable patterns from task artifacts (findings, plans, patches).
 *
 * Phase 1: Deterministic pattern extraction using keyword clustering.
 * Phase 2 (future): LLM-enhanced semantic pattern grouping.
 */
export class PatternExtractor {
  /**
   * Extract fault patterns from a list of findings.
   * Groups similar descriptions and counts frequencies.
   */
  extractFaultPatterns(findings: Finding[]): FaultPattern[] {
    const patterns = new Map<string, { pattern: string; count: number; language?: string }>();

    for (const finding of findings) {
      if (finding.type !== 'fault' && finding.type !== 'style') continue;

      // Normalize description: remove file-specific parts
      const normalized = this.normalizeDescription(finding.description);
      const key = this.fuzzyKey(normalized);

      const existing = patterns.get(key);
      if (existing) {
        existing.count++;
      } else {
        patterns.set(key, {
          pattern: normalized,
          count: 1,
          language: this.inferLanguage(finding.nodeIds),
        });
      }
    }

    return Array.from(patterns.values()).map((p, idx) => ({
      id: `fp-${this.slug(p.pattern)}-${idx}`,
      pattern: p.pattern,
      language: p.language,
      frequency: p.count,
    }));
  }

  /**
   * Extract fix patterns from a solution plan.
   */
  extractFixPatterns(plan: SolutionPlan): FixPattern[] {
    const patterns: FixPattern[] = [];

    for (const change of plan.changes) {
      const pattern = this.inferFixPattern(change.description, change.reasoning);
      if (pattern) {
        patterns.push({
          id: `fix-${this.slug(pattern)}`,
          pattern,
          language: this.inferLanguage([change.filePath]),
          frequency: 1,
        });
      }
    }

    return patterns;
  }

  private normalizeDescription(desc: string): string {
    // Remove file paths and line numbers
    return desc
      .replace(/\s+in\s+\S+\.\w+/g, '')
      .replace(/\s+at\s+line\s+\d+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private fuzzyKey(desc: string): string {
    // Simple keyword-based clustering
    const keywords = ['null', 'undefined', 'unused', 'memory leak', 'error handling', 'type safety'];
    for (const kw of keywords) {
      if (desc.toLowerCase().includes(kw)) return kw;
    }
    // First 3 words as fallback key
    return desc.toLowerCase().split(' ').slice(0, 3).join('-');
  }

  private inferFixPattern(description: string, reasoning: string): string | null {
    const text = `${description} ${reasoning}`.toLowerCase();

    if (text.includes('optional chaining') || text.includes('?.') || text.includes('null')) {
      return 'Add optional chaining for null safety';
    }
    if (text.includes('logger') || text.includes('console.log')) {
      return 'Replace console.log with structured logger';
    }
    if (text.includes('catch') || text.includes('error handling')) {
      return 'Add try/catch error handling';
    }
    if (text.includes('unused') || text.includes('dead code')) {
      return 'Remove unused code';
    }

    // Generic fallback
    return description || null;
  }

  private inferLanguage(nodeIds: string[]): string | undefined {
    const path = nodeIds[0] || '';
    if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
    if (path.endsWith('.js') || path.endsWith('.jsx')) return 'javascript';
    if (path.endsWith('.py')) return 'python';
    return undefined;
  }

  private slug(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30);
  }
}
