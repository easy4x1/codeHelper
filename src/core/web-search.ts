import type { WebSearchQuery, WebSearchResult, SearchTemplate, WebSearchStrategy } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('web-search');

export const DEFAULT_TEMPLATES: SearchTemplate[] = [
  {
    name: 'error_message',
    template: '{errorMessage} {language} {framework}',
    priority: 1,
    example: "TypeError: Cannot read property 'map' of undefined react",
  },
  {
    name: 'stack_trace',
    template: '{stackTraceTopFrame} {library} {version} bug',
    priority: 2,
    example: 'useEffect cleanup memory leak react 18',
  },
  {
    name: 'pattern',
    template: '{framework} {pattern} best practice',
    priority: 3,
    example: 'vue composition api error handling pattern',
  },
  {
    name: 'compatibility',
    template: '{library} {version} breaking change migration',
    priority: 4,
    example: 'typescript 5.0 decorators breaking change',
  },
];

export function buildQuery(
  params: {
    errorMessage?: string;
    stackTraceTopFrame?: string;
    language?: string;
    framework?: string;
    library?: string;
    version?: string;
    pattern?: string;
  },
  templates: SearchTemplate[]
): WebSearchQuery {
  const sorted = [...templates].sort((a, b) => a.priority - b.priority);
  const usedTemplates: string[] = [];
  let query = '';

  for (const template of sorted) {
    let filled = template.template;
    let used = false;
    const hasPlaceholders = /\{\w+\}/.test(filled);

    for (const [key, value] of Object.entries(params)) {
      if (value && filled.includes(`{${key}}`)) {
        filled = filled.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
        used = true;
      }
    }

    // Use template if: (a) we filled at least one placeholder, or (b) template has no placeholders (pure text)
    if (used || !hasPlaceholders) {
      // Remove any unfilled placeholders
      filled = filled.replace(/\{\w+\}/g, '').trim();
      if (filled) {
        query = filled;
        usedTemplates.push(template.name);
        break; // Use highest priority matching template
      }
    }
  }

  return { query, templates: usedTemplates, language: params.language, framework: params.framework };
}

/**
 * Simulation provider for testing and MVP.
 * Returns deterministic results based on query keywords.
 */
export async function simulateSearch(query: WebSearchQuery): Promise<WebSearchResult[]> {
  if (!query.query.trim()) return [];

  const q = query.query.toLowerCase();
  const results: WebSearchResult[] = [];

  if (q.includes('map') && q.includes('undefined')) {
    results.push({
      title: "TypeError: Cannot read property 'map' of undefined",
      url: 'https://stackoverflow.com/questions/12345',
      snippet: 'Check if the array is defined before calling .map(). Use optional chaining: arr?.map(...) or ensure initialization.',
      source: 'stackoverflow',
      credibilityScore: 0.92,
    });
  }

  if (q.includes('null') || q.includes('undefined')) {
    results.push({
      title: 'Handling null and undefined in JavaScript',
      url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Optional_chaining',
      snippet: 'The optional chaining operator (?.) enables you to read the value of a property located deep within a chain of connected objects.',
      source: 'mdn',
      credibilityScore: 0.95,
    });
  }

  if (q.includes('memory leak') || q.includes('cleanup')) {
    results.push({
      title: 'React useEffect cleanup function guide',
      url: 'https://react.dev/reference/react/useEffect',
      snippet: 'To prevent memory leaks, return a cleanup function from useEffect. This is especially important for subscriptions and timers.',
      source: 'react-docs',
      credibilityScore: 0.90,
    });
  }

  if (q.includes('async') || q.includes('await') || q.includes('promise')) {
    results.push({
      title: 'JavaScript async/await error handling patterns',
      url: 'https://javascript.info/async-await',
      snippet: 'Always wrap await calls in try/catch blocks. Unhandled promise rejections can crash Node.js applications.',
      source: 'javascript-info',
      credibilityScore: 0.88,
    });
  }

  // Generic fallback result for any query
  if (results.length === 0) {
    results.push({
      title: `Search results for: ${query.query}`,
      url: 'https://github.com/search',
      snippet: `No specific match found. Try searching GitHub issues or Stack Overflow for "${query.query}".`,
      source: 'generic',
      credibilityScore: 0.3,
    });
  }

  logger.info(`Simulated search for "${query.query}" returned ${results.length} result(s)`);
  return results.sort((a, b) => b.credibilityScore - a.credibilityScore);
}

export class WebSearchEngine {
  private strategy: WebSearchStrategy;

  constructor(strategy?: Partial<WebSearchStrategy>) {
    this.strategy = {
      triggers: {
        localConfidenceThreshold: 0.5,
        noveltyThreshold: 0.3,
        minQueryQuality: 0.2,
        ...strategy?.triggers,
      },
      queryBuilder: {
        templates: DEFAULT_TEMPLATES,
        enrichment: { includeStackTrace: true, includeVersions: true, includeContext: true },
        ...strategy?.queryBuilder,
      },
      fusion: {
        strategy: 'weighted',
        weights: { localKnowledge: 0.6, webSearch: 0.4, historicalFix: 0.3 },
        ...strategy?.fusion,
      },
    };
  }

  shouldSearch(context: { localConfidence: number; findingCount: number }): boolean {
    if (context.findingCount === 0) return false;
    if (context.localConfidence < this.strategy.triggers.localConfidenceThreshold) return true;
    if (context.findingCount <= 1 && context.localConfidence < 0.7) return true;
    return false;
  }

  async search(
    params: {
      errorMessage?: string;
      stackTraceTopFrame?: string;
      language?: string;
      framework?: string;
      library?: string;
      version?: string;
    },
    context?: { localConfidence: number; findingCount: number }
  ): Promise<WebSearchResult[]> {
    if (context && !this.shouldSearch(context)) {
      logger.info('Skipping web search — local confidence is sufficient');
      return [];
    }

    const query = buildQuery(params, this.strategy.queryBuilder.templates);
    if (!query.query) {
      logger.warn('Empty search query — skipping');
      return [];
    }

    logger.info(`Web search query: "${query.query}" (templates: ${query.templates.join(', ')})`);
    return simulateSearch(query);
  }
}
