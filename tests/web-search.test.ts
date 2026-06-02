import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WebSearchQuery, WebSearchResult, SearchTemplate } from '../src/core/types.js';
import {
  WebSearchEngine,
  DEFAULT_TEMPLATES,
  buildQuery,
  simulateSearch,
  DuckDuckGoSearchProvider,
  type SearchProvider,
} from '../src/core/web-search.js';

describe('WebSearch types', () => {
  it('WebSearchQuery has required fields', () => {
    const q: WebSearchQuery = {
      query: 'TypeError Cannot read property map of undefined react',
      templates: ['error_message'],
      language: 'typescript',
      framework: 'react',
    };
    expect(q.query).toBeDefined();
    expect(q.templates).toContain('error_message');
  });

  it('WebSearchResult has required fields', () => {
    const r: WebSearchResult = {
      title: 'Fix for React map error',
      url: 'https://example.com/fix',
      snippet: 'Ensure the array is defined before calling map()',
      source: 'stackoverflow',
      credibilityScore: 0.85,
    };
    expect(r.credibilityScore).toBeGreaterThanOrEqual(0);
    expect(r.credibilityScore).toBeLessThanOrEqual(1);
  });
});

describe('DEFAULT_TEMPLATES', () => {
  it('contains expected templates', () => {
    expect(DEFAULT_TEMPLATES).toHaveLength(4);
    const names = DEFAULT_TEMPLATES.map((t) => t.name);
    expect(names).toContain('error_message');
    expect(names).toContain('stack_trace');
    expect(names).toContain('pattern');
    expect(names).toContain('compatibility');
  });
});

describe('buildQuery', () => {
  it('builds query from error_message template', () => {
    const result = buildQuery(
      {
        errorMessage: "Cannot read property 'map' of undefined",
        language: 'javascript',
        framework: 'react',
      },
      DEFAULT_TEMPLATES
    );
    expect(result.query).toContain("Cannot read property 'map' of undefined");
    expect(result.query).toContain('javascript');
    expect(result.query).toContain('react');
    expect(result.templates).toContain('error_message');
  });

  it('returns empty query when no matching templates', () => {
    const result = buildQuery({}, []);
    expect(result.query).toBe('');
    expect(result.templates).toEqual([]);
  });

  it('prioritizes higher priority templates', () => {
    const templates: SearchTemplate[] = [
      { name: 'low', template: 'low', priority: 10, example: '' },
      { name: 'high', template: 'high', priority: 1, example: '' },
    ];
    const result = buildQuery({}, templates);
    expect(result.templates[0]).toBe('high');
  });
});

describe('simulateSearch', () => {
  it('returns results for known error patterns', async () => {
    const results = await simulateSearch({
      query: 'Cannot read property map of undefined react',
      templates: ['error_message'],
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBeDefined();
    expect(results[0].credibilityScore).toBeGreaterThanOrEqual(0);
  });

  it('returns empty results for empty query', async () => {
    const results = await simulateSearch({ query: '', templates: [] });
    expect(results).toEqual([]);
  });
});

describe('DuckDuckGoSearchProvider', () => {
  it('parses DuckDuckGo HTML results', async () => {
    const provider = new DuckDuckGoSearchProvider();

    // Mock fetch
    const mockHtml = `
      <div class="result results_links results_links_deep web-result">
        <h2 class="result__title"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fstackoverflow.com%2Fquestions%2F123">TypeError: Cannot read property 'map' of undefined</a></h2>
        <a class="result__url" href="/l/?uddg=https%3A%2F%2Fstackoverflow.com%2Fquestions%2F123">stackoverflow.com/questions/123</a>
        <div class="result__snippet">Check if array is defined before calling .map()</div>
      </div>
      <div class="result results_links results_links_deep web-result">
        <h2 class="result__title"><a class="result__a" href="https://developer.mozilla.org">Handling null and undefined</a></h2>
        <a class="result__url" href="https://developer.mozilla.org">developer.mozilla.org</a>
        <div class="result__snippet">The optional chaining operator enables you to read values safely</div>
      </div>
    `;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => mockHtml,
    } as unknown as Response);

    const results = await provider.search('TypeError Cannot read property map of undefined react');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toContain('TypeError');
    expect(results[0].source).toBe('stackoverflow');
    expect(results[0].credibilityScore).toBeGreaterThan(0.9);

    vi.restoreAllMocks();
  });

  it('returns empty array when fetch fails', async () => {
    const provider = new DuckDuckGoSearchProvider();

    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const results = await provider.search('test query');
    expect(results).toEqual([]);

    vi.restoreAllMocks();
  });

  it('returns empty array when response is not ok', async () => {
    const provider = new DuckDuckGoSearchProvider();

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    } as unknown as Response);

    const results = await provider.search('test query');
    expect(results).toEqual([]);

    vi.restoreAllMocks();
  });
});

describe('WebSearchEngine with provider', () => {
  let engine: WebSearchEngine;

  beforeEach(() => {
    engine = new WebSearchEngine({
      triggers: {
        localConfidenceThreshold: 0.5,
        noveltyThreshold: 0.3,
        minQueryQuality: 0.2,
      },
      queryBuilder: {
        templates: DEFAULT_TEMPLATES,
        enrichment: { includeStackTrace: true, includeVersions: true, includeContext: true },
      },
      fusion: {
        strategy: 'weighted',
        weights: { localKnowledge: 0.6, webSearch: 0.4, historicalFix: 0.3 },
      },
    });
  });

  it('shouldSearch returns true when local confidence is low', () => {
    expect(engine.shouldSearch({ localConfidence: 0.3, findingCount: 2 })).toBe(true);
  });

  it('shouldSearch returns false when local confidence is high', () => {
    expect(engine.shouldSearch({ localConfidence: 0.8, findingCount: 2 })).toBe(false);
  });

  it('shouldSearch returns false when no findings', () => {
    expect(engine.shouldSearch({ localConfidence: 0.1, findingCount: 0 })).toBe(false);
  });

  it('search returns results from custom provider', async () => {
    const mockProvider: SearchProvider = {
      async search(query: string) {
        return [
          {
            title: `Custom: ${query}`,
            url: 'https://example.com',
            snippet: 'Custom result',
            source: 'custom',
            credibilityScore: 0.8,
          },
        ];
      },
    };

    const customEngine = new WebSearchEngine({}, mockProvider);
    const results = await customEngine.search({
      errorMessage: "Cannot read property 'map' of undefined",
      language: 'javascript',
      framework: 'react',
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toContain("Cannot read property 'map' of undefined");
    expect(results[0].source).toBe('custom');
  });

  it('search falls back to simulation when provider returns empty', async () => {
    const emptyProvider: SearchProvider = {
      async search() {
        return [];
      },
    };

    const customEngine = new WebSearchEngine({}, emptyProvider);
    const results = await customEngine.search({
      errorMessage: "Cannot read property 'map' of undefined",
      language: 'javascript',
    });
    expect(results.length).toBeGreaterThan(0);
  });

  it('search returns empty when shouldSearch is false', async () => {
    const results = await engine.search(
      {
        errorMessage: 'minor issue',
      },
      { localConfidence: 0.9, findingCount: 5 }
    );
    expect(results).toEqual([]);
  });
});
