import { describe, it, expect } from 'vitest';
import type { WebSearchQuery, WebSearchResult, SearchTemplate } from '../src/core/types.js';

describe('WebSearch types', () => {
  it('WebSearchQuery has required fields', () => {
    const q: WebSearchQuery = {
      query: 'TypeError Cannot read property map of undefined react',
      templates: ['error_message'],
      language: 'typescript',
      framework: 'react',
    };
    expect(q.query).toBe('TypeError Cannot read property map of undefined react');
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

  it('SearchTemplate has required fields', () => {
    const t: SearchTemplate = {
      name: 'error_message',
      template: '{errorMessage} {language} {framework}',
      priority: 1,
      example: 'TypeError: Cannot read property map of undefined react',
    };
    expect(t.priority).toBe(1);
  });
});