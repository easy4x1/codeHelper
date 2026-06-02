import { describe, it, expect, beforeEach } from 'vitest';
import type { WebSearchQuery, WebSearchResult, SearchTemplate } from '../src/core/types.js';
import { WebSearchEngine, DEFAULT_TEMPLATES, buildQuery, simulateSearch } from '../src/core/web-search.js';

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
    const names = DEFAULT_TEMPLATES.map(t => t.name);
    expect(names).toContain('error_message');
    expect(names).toContain('stack_trace');
    expect(names).toContain('pattern');
    expect(names).toContain('compatibility');
  });
});

describe('buildQuery', () => {
  it('builds query from error_message template', () => {
    const result = buildQuery({
      errorMessage: "Cannot read property 'map' of undefined",
      language: 'javascript',
      framework: 'react',
    }, DEFAULT_TEMPLATES);
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
    const results = await simulateSearch({ query: 'Cannot read property map of undefined react', templates: ['error_message'] });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBeDefined();
    expect(results[0].credibilityScore).toBeGreaterThanOrEqual(0);
  });

  it('returns empty results for empty query', async () => {
    const results = await simulateSearch({ query: '', templates: [] });
    expect(results).toEqual([]);
  });
});

describe('WebSearchEngine', () => {
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

  it('search returns results for valid query', async () => {
    const results = await engine.search({
      errorMessage: "Cannot read property 'map' of undefined",
      language: 'javascript',
      framework: 'react',
    });
    expect(results.length).toBeGreaterThan(0);
  });

  it('search returns empty when shouldSearch is false', async () => {
    const results = await engine.search({
      errorMessage: 'minor issue',
    }, { localConfidence: 0.9, findingCount: 5 });
    expect(results).toEqual([]);
  });
});
