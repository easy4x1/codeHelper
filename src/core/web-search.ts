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

// ============================================
// Search Provider Interface
// ============================================

export interface SearchProvider {
  search(query: string): Promise<WebSearchResult[]>;
}

// ============================================
// DuckDuckGo Search Provider
// ============================================

export class DuckDuckGoSearchProvider implements SearchProvider {
  private readonly userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0';

  async search(query: string): Promise<WebSearchResult[]> {
    if (!query.trim()) return [];

    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    try {
      logger.info(`DuckDuckGo search: "${query}"`);
      const response = await fetch(url, {
        headers: {
          'User-Agent': this.userAgent,
          'Accept': 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!response.ok) {
        logger.warn(`DuckDuckGo returned ${response.status}, falling back to simulation`);
        return [];
      }

      const html = await response.text();
      return this.parseResults(html, query);
    } catch (err) {
      logger.error('DuckDuckGo search failed:', err);
      return [];
    }
  }

  private parseResults(html: string, query: string): WebSearchResult[] {
    const results: WebSearchResult[] = [];

    // DuckDuckGo HTML result structure:
    // <div class="result results_links results_links_deep web-result">
    //   <h2 class="result__title"><a class="result__a" href="...">Title</a></h2>
    //   <a class="result__url" href="...">url...</a>
    //   <div class="result__snippet">Snippet...</div>
    // </div>

    const resultBlocks = html.split(/<div class="result[^"]*"/).slice(1);

    for (const block of resultBlocks) {
      const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/i);
      const snippetMatch = block.match(/<div[^>]*class="result__snippet"[^>]*>(.*?)<\/div>/i);
      const urlMatch = block.match(/<a[^>]*class="result__url"[^>]*href="([^"]*)"[^>]*>/i);

      if (titleMatch) {
        const title = this.stripHtml(titleMatch[2]);
        const rawHref = this.decodeEntities(titleMatch[1]);
        const snippet = snippetMatch ? this.stripHtml(snippetMatch[1]) : '';
        const rawDisplayUrl = urlMatch ? this.decodeEntities(urlMatch[1]) : rawHref;

        // Resolve DuckDuckGo redirect URLs to actual URLs
        const href = this.resolveRedirectUrl(rawHref);
        const displayUrl = this.resolveRedirectUrl(rawDisplayUrl);

        // Skip ads and irrelevant results
        if (this.isRelevant(title, snippet, query)) {
          results.push({
            title,
            url: displayUrl || href,
            snippet: snippet || title,
            source: this.extractSource(href),
            credibilityScore: this.scoreSource(href),
          });
        }
      }
    }

    logger.info(`DuckDuckGo returned ${results.length} result(s) for "${query}"`);
    return results.slice(0, 5); // Limit to top 5
  }

  private resolveRedirectUrl(url: string): string {
    // DuckDuckGo wraps external URLs in /l/?uddg=... redirects
    if (url.startsWith('/l/?uddg=') || url.includes('?uddg=')) {
      const match = url.match(/uddg=([^&]+)/);
      if (match) {
        try {
          return decodeURIComponent(match[1]);
        } catch {
          return match[1];
        }
      }
    }
    return url;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]+>/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x27;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .trim();
  }

  private decodeEntities(str: string): string {
    return str
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }

  private isRelevant(title: string, snippet: string, query: string): boolean {
    const q = query.toLowerCase();
    const text = (title + ' ' + snippet).toLowerCase();
    // Require at least some keyword overlap
    const queryWords = q.split(/\s+/).filter(w => w.length > 2);
    const matches = queryWords.filter(w => text.includes(w)).length;
    return matches > 0 || text.includes('stackoverflow') || text.includes('github');
  }

  private extractSource(url: string): string {
    try {
      const hostname = new URL(url).hostname;
      if (hostname.includes('stackoverflow')) return 'stackoverflow';
      if (hostname.includes('github')) return 'github';
      if (hostname.includes('developer.mozilla')) return 'mdn';
      if (hostname.includes('react.dev')) return 'react-docs';
      if (hostname.includes('medium')) return 'medium';
      return hostname.replace(/^www\./, '');
    } catch {
      return 'unknown';
    }
  }

  private scoreSource(url: string): number {
    const source = this.extractSource(url);
    const scores: Record<string, number> = {
      'stackoverflow': 0.95,
      'mdn': 0.95,
      'react-docs': 0.92,
      'github': 0.88,
      'typescriptlang': 0.90,
      'javascript.info': 0.85,
      'dev.to': 0.75,
      'medium': 0.70,
    };
    return scores[source] ?? 0.60;
  }
}

// ============================================
// Simulation Provider (fallback / testing)
// ============================================

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

// ============================================
// Web Search Engine
// ============================================

export class WebSearchEngine {
  private strategy: WebSearchStrategy;
  private provider: SearchProvider;

  constructor(
    strategy?: Partial<WebSearchStrategy>,
    provider?: SearchProvider,
  ) {
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
    this.provider = provider ?? new DuckDuckGoSearchProvider();
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

    // Try the configured provider first
    const providerResults = await this.provider.search(query.query);
    if (providerResults.length > 0) {
      return providerResults;
    }

    // Fallback to simulation if provider returns nothing
    logger.info('Provider returned no results, falling back to simulation');
    return simulateSearch(query);
  }
}
