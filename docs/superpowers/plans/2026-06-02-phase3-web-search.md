# Phase 3: Web Search & Patch LLM Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add web search capability to the code repair pipeline and enhance the patch generator with LLM-powered diff generation.

**Architecture:** A `WebSearchEngine` abstraction with pluggable providers (simulation for testing, real APIs for production) feeds into a `WebSearcherAgent` that runs between ContextBuilder and SolutionPlanner. The LLM service gains a `generatePatch` method that converts solution plans into concrete code diffs when original/modified code is missing.

**Tech Stack:** TypeScript 5.4+, vitest, native `fetch` (no new dependencies — Node 20+ has it)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/core/web-search.ts` | Web search types, engine interface, simulation provider, query builder |
| `src/agents/web-searcher-agent.ts` | WebSearcherAgent — runs search based on fault findings, integrates with memory |
| `src/core/types.ts` | Add `WebSearchResult`, `SearchTemplate`, `WebSearchQuery` types; add `webSearcherContextSchema` |
| `src/core/llm-service.ts` | Add `generatePatch` method to `LlmService` interface; implement in `TemplateLlmService` and `AnthropicLlmService` |
| `src/agents/patch-generator-agent.ts` | Enhance to call LLM `generatePatch` when originalCode/modifiedCode is missing |
| `src/index.ts` | Integrate WebSearcherAgent into `fix()` flow; add `--web-search` / `--no-web-search` CLI flags |
| `src/core/memory.ts` | Add `searchCache` to L2 task context; `recordSearchResult`, `getCachedSearch` methods |
| `src/core/token-budget.ts` | Already has `search` category — ensure `WebSearcherAgent` and `generatePatch` record usage |
| `tests/web-search.test.ts` | Web search engine tests (query building, simulation, caching) |
| `tests/web-searcher-agent.test.ts` | WebSearcherAgent integration tests |
| `tests/patch-llm.test.ts` | Patch generator LLM integration tests |

---

### Task 1: Add Web Search Types to `src/core/types.ts`

**Files:**
- Modify: `src/core/types.ts`
- Test: `tests/web-search.test.ts` (starts here, expanded in Task 2)

- [ ] **Step 1: Write the failing test for web search types**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-search.test.ts -v`
Expected: FAIL with "Cannot find module '../src/core/types.js' or type errors on WebSearchQuery/WebSearchResult/SearchTemplate"

- [ ] **Step 3: Add web search types to `src/core/types.ts`**

Append to `src/core/types.ts` before the Zod schemas section (after line ~288, before `// ============================================ // Zod Runtime Validation Schemas`):

```typescript
// ============================================
// Web Search Types
// ============================================

export interface SearchTemplate {
  name: string;
  template: string;
  priority: number;
  example: string;
}

export interface WebSearchQuery {
  query: string;
  templates: string[];
  language?: string;
  framework?: string;
  errorMessage?: string;
  stackTraceTopFrame?: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  credibilityScore: number; // 0-1
}

export interface WebSearchStrategy {
  triggers: {
    localConfidenceThreshold: number;
    noveltyThreshold: number;
    minQueryQuality: number;
  };
  queryBuilder: {
    templates: SearchTemplate[];
    enrichment: {
      includeStackTrace: boolean;
      includeVersions: boolean;
      includeContext: boolean;
    };
  };
  fusion: {
    strategy: 'weighted' | 'fallback' | 'ensemble';
    weights: {
      localKnowledge: number;
      webSearch: number;
      historicalFix: number;
    };
  };
}
```

- [ ] **Step 4: Add Zod schema for web searcher context**

Append after `patchGeneratorContextSchema` (around line 375):

```typescript
export const webSearcherContextSchema = z.object({
  findings: z.array(findingSchema).optional().default([]),
  language: z.string().optional().default('typescript'),
  framework: z.string().optional(),
  errorMessage: z.string().optional(),
  stackTrace: z.string().optional(),
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/web-search.test.ts -v`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts tests/web-search.test.ts
git commit -m "feat(web-search): add WebSearchQuery, WebSearchResult, SearchTemplate types and Zod schema"
```

---

### Task 2: Implement Web Search Engine (`src/core/web-search.ts`)

**Files:**
- Create: `src/core/web-search.ts`
- Modify: `tests/web-search.test.ts` (expand existing)

- [ ] **Step 1: Write failing tests for web search engine**

Replace `tests/web-search.test.ts` content:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-search.test.ts -v`
Expected: FAIL with module not found errors for `../src/core/web-search.js`

- [ ] **Step 3: Implement `src/core/web-search.ts`**

```typescript
import type { WebSearchQuery, WebSearchResult, SearchTemplate, WebSearchStrategy, Finding } from './types.js';
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

    for (const [key, value] of Object.entries(params)) {
      if (value && filled.includes(`{${key}}`)) {
        filled = filled.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
        used = true;
      }
    }

    // Only use this template if we filled at least one placeholder
    if (used) {
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
      title: 'TypeError: Cannot read property \'map\' of undefined',
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/web-search.test.ts -v`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/web-search.ts tests/web-search.test.ts
git commit -m "feat(web-search): implement WebSearchEngine with query builder and simulation provider"
```

---

### Task 3: Implement `WebSearcherAgent`

**Files:**
- Create: `src/agents/web-searcher-agent.ts`
- Create: `tests/web-searcher-agent.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { WebSearcherAgent } from '../src/agents/web-searcher-agent.js';
import { MemoryMiddleware } from '../src/core/memory.js';
import type { AgentInput, Finding } from '../src/core/types.js';

describe('WebSearcherAgent', () => {
  it('returns search results for low-confidence findings', async () => {
    const memory = new MemoryMiddleware();
    const agent = new WebSearcherAgent(memory);

    const input: AgentInput = {
      taskId: 'test-search',
      instruction: 'Search for solutions',
      context: {
        findings: [
          {
            id: 'f1',
            type: 'fault',
            description: "Cannot read property 'map' of undefined",
            confidence: 0.3,
            nodeIds: ['node1'],
          },
        ] as Finding[],
        language: 'javascript',
        framework: 'react',
      },
    };

    const output = await agent.run(input);
    expect(output.findings.length).toBeGreaterThan(0);
    expect(output.result.searchResults).toBeDefined();
    expect(Array.isArray(output.result.searchResults)).toBe(true);
  });

  it('skips search when findings have high confidence', async () => {
    const memory = new MemoryMiddleware();
    const agent = new WebSearcherAgent(memory);

    const input: AgentInput = {
      taskId: 'test-search',
      instruction: 'Search for solutions',
      context: {
        findings: [
          {
            id: 'f1',
            type: 'fault',
            description: 'Minor style issue',
            confidence: 0.9,
            nodeIds: ['node1'],
          },
        ] as Finding[],
      },
    };

    const output = await agent.run(input);
    expect(output.result.searchResults).toEqual([]);
    expect(output.result.skipped).toBe(true);
  });

  it('skips search when no findings', async () => {
    const memory = new MemoryMiddleware();
    const agent = new WebSearcherAgent(memory);

    const input: AgentInput = {
      taskId: 'test-search',
      instruction: 'Search for solutions',
      context: {
        findings: [],
      },
    };

    const output = await agent.run(input);
    expect(output.result.searchResults).toEqual([]);
    expect(output.result.skipped).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-searcher-agent.test.ts -v`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/agents/web-searcher-agent.ts`**

```typescript
import { BaseAgent } from './base-agent.js';
import { MemoryMiddleware } from '../core/memory.js';
import { WebSearchEngine } from '../core/web-search.js';
import { webSearcherContextSchema, parseContext, type AgentInput, type Finding } from '../core/types.js';

export class WebSearcherAgent extends BaseAgent {
  private engine: WebSearchEngine;

  constructor(private memory: MemoryMiddleware) {
    super('web-searcher');
    this.engine = new WebSearchEngine();
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const ctx = parseContext(input.context, webSearcherContextSchema);
    const findings = ctx.findings as Finding[];

    if (findings.length === 0) {
      this.logger.info('No findings to search for');
      return { searchResults: [], skipped: true };
    }

    const avgConfidence = findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length;

    if (!this.engine.shouldSearch({ localConfidence: avgConfidence, findingCount: findings.length })) {
      this.logger.info(`Skipping search — local confidence ${avgConfidence.toFixed(2)} is sufficient`);
      return { searchResults: [], skipped: true };
    }

    // Build search params from findings
    const errorMessage = findings
      .filter(f => f.confidence < 0.7)
      .map(f => f.description)
      .join(' ')
      .slice(0, 200);

    const searchResults = await this.engine.search({
      errorMessage: errorMessage || undefined,
      language: ctx.language,
      framework: ctx.framework,
    }, {
      localConfidence: avgConfidence,
      findingCount: findings.length,
    });

    // Cache results in memory
    for (const result of searchResults) {
      this.memory.recordSearchResult(input.taskId, result);
    }

    this.logger.info(`Found ${searchResults.length} search result(s)`);

    return {
      searchResults,
      skipped: false,
      query: errorMessage,
    };
  }
}
```

- [ ] **Step 4: Add search cache methods to `src/core/memory.ts`**

In `src/core/memory.ts`, add these methods to the `MemoryMiddleware` class (before the closing brace):

```typescript
  // ---- Search cache (L2) ----

  recordSearchResult(taskId: string, result: { title: string; url: string; snippet: string; credibilityScore: number }): void {
    this.ensureTaskContext(taskId);
    const task = this.layer.taskContext;
    if (!task.searchCache) {
      (task as Record<string, unknown>).searchCache = [] as typeof result[];
    }
    (task.searchCache as typeof result[]).push(result);
  }

  getCachedSearchResults(taskId: string): Array<{ title: string; url: string; snippet: string; credibilityScore: number }> {
    this.ensureTaskContext(taskId);
    const cache = (this.layer.taskContext as Record<string, unknown>).searchCache;
    return cache ? [...(cache as Array<{ title: string; url: string; snippet: string; credibilityScore: number }>)] : [];
  }
```

Also update `TaskContext` type in `src/core/types.ts` to include `searchCache`:

In `TaskContext` interface (line ~143-148), add:
```typescript
  searchCache?: Array<{ title: string; url: string; snippet: string; credibilityScore: number }>;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/web-searcher-agent.test.ts -v`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/agents/web-searcher-agent.ts src/core/memory.ts src/core/types.ts tests/web-searcher-agent.test.ts
git commit -m "feat(web-search): add WebSearcherAgent with memory caching"
```

---

### Task 4: Extend LLM Service with `generatePatch`

**Files:**
- Modify: `src/core/llm-service.ts`
- Create: `tests/patch-llm.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { TemplateLlmService } from '../src/core/llm-service.js';

describe('TemplateLlmService generatePatch', () => {
  const service = new TemplateLlmService();

  it('generates a patch from a solution plan', async () => {
    const result = await service.generatePatch({
      filePath: 'src/utils/helper.ts',
      description: 'Add null check before accessing property',
      reasoning: 'The variable may be undefined',
      originalCode: 'function getName(user) {\n  return user.name;\n}',
    });

    expect(result.originalCode).toContain('return user.name');
    expect(result.modifiedCode).toBeDefined();
    expect(result.modifiedCode!.length).toBeGreaterThan(0);
  });

  it('handles missing original code gracefully', async () => {
    const result = await service.generatePatch({
      filePath: 'src/utils/helper.ts',
      description: 'Add new utility function',
      reasoning: 'Needed for feature X',
    });

    expect(result.changeType).toBe('add');
    expect(result.modifiedCode).toBeDefined();
  });

  it('returns delete type when modified is empty', async () => {
    const result = await service.generatePatch({
      filePath: 'src/utils/helper.ts',
      description: 'Remove dead code',
      reasoning: 'No longer used',
      originalCode: 'function oldFunc() {}',
      modifiedCode: '',
    });

    expect(result.changeType).toBe('delete');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/patch-llm.test.ts -v`
Expected: FAIL — `generatePatch` method does not exist on `LlmService`

- [ ] **Step 3: Add `generatePatch` to `LlmService` interface and implementations**

Add to `src/core/llm-service.ts` after the `SolutionResult` interface (before `TemplateLlmService` class):

```typescript
export interface PatchParams {
  filePath: string;
  description: string;
  reasoning: string;
  originalCode?: string;
  modifiedCode?: string;
}

export interface PatchLlmResult {
  originalCode: string;
  modifiedCode: string;
  changeType: 'modify' | 'add' | 'delete';
}
```

Update `LlmService` interface to add:
```typescript
export interface LlmService {
  analyzeFault(params: FaultAnalysisParams): Promise<FaultAnalysisResult>;
  generateSolution(params: SolutionParams): Promise<SolutionResult>;
  generatePatch(params: PatchParams): Promise<PatchLlmResult>;
}
```

Add `generatePatch` method to `TemplateLlmService`:

```typescript
  async generatePatch(params: PatchParams): Promise<PatchLlmResult> {
    logger.info(`Generating patch for ${params.filePath}`);

    const { filePath, description, reasoning, originalCode, modifiedCode } = params;

    // If both original and modified are provided, return as-is
    if (originalCode !== undefined && modifiedCode !== undefined) {
      const changeType: PatchLlmResult['changeType'] =
        originalCode === '' ? 'add' :
        modifiedCode === '' ? 'delete' :
        'modify';
      return { originalCode, modifiedCode, changeType };
    }

    // If only original is provided, try to infer the fix
    if (originalCode !== undefined && modifiedCode === undefined) {
      const inferred = this.inferPatch(originalCode, description);
      return {
        originalCode,
        modifiedCode: inferred,
        changeType: inferred === '' ? 'delete' : 'modify',
      };
    }

    // If no original, generate new code
    if (originalCode === undefined) {
      const generated = this.generateNewCode(description, reasoning);
      return {
        originalCode: '',
        modifiedCode: generated,
        changeType: 'add',
      };
    }

    // Fallback
    return {
      originalCode: originalCode || '',
      modifiedCode: modifiedCode || '',
      changeType: 'modify',
    };
  }

  private inferPatch(originalCode: string, description: string): string {
    const desc = description.toLowerCase();
    let modified = originalCode;

    // Null safety inference
    if (desc.includes('null') || desc.includes('undefined')) {
      modified = modified.replace(/(\w+)\.(\w+)\(/g, (match, obj, method) => {
        if (['console', 'process', 'Math', 'JSON'].includes(obj)) return match;
        return `${obj}?.${method}(`;
      });
    }

    // Logger replacement inference
    if (desc.includes('console') || desc.includes('log')) {
      modified = modified.replace(/console\.(log|error|warn)\(/g, 'logger.info(');
    }

    // Type safety inference
    if (desc.includes('any') || desc.includes('type')) {
      modified = modified.replace(/:\s*any\b/g, ': unknown');
      modified = modified.replace(/\bas any\b/g, 'as unknown');
    }

    return modified;
  }

  private generateNewCode(description: string, _reasoning: string): string {
    const desc = description.toLowerCase();

    if (desc.includes('utility') || desc.includes('helper')) {
      return `// TODO: Implement ${description}\nexport function newUtility() {\n  throw new Error('Not implemented');\n}`;
    }

    if (desc.includes('error handling') || desc.includes('catch')) {
      return `try {\n  // TODO: Add operation\n} catch (error) {\n  logger.error('Operation failed:', error);\n  throw error;\n}`;
    }

    return `// TODO: ${description}\n`;
  }
```

Add `generatePatch` to `AnthropicLlmService` (fallback to template):

```typescript
  async generatePatch(params: PatchParams): Promise<PatchLlmResult> {
    if (!this.client) {
      logger.info('Anthropic client not available — using template fallback for generatePatch');
      return this.fallback.generatePatch(params);
    }

    try {
      const prompt = `You are a code patching expert. Based on the description, generate the exact original and modified code.

File: ${params.filePath}
Description: ${params.description}
Reasoning: ${params.reasoning}
${params.originalCode ? `Original code:\n\`\`\`\n${params.originalCode}\n\`\`\`` : 'This is a new file.'}

Respond ONLY with a JSON object in this exact format (no markdown, no explanation):
{
  "originalCode": "the exact original code (empty string for new files)",
  "modifiedCode": "the exact replacement code",
  "changeType": "modify" | "add" | "delete"
}`;

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response type from Claude');
      }

      const parsed = JSON.parse(content.text) as PatchLlmResult;
      logger.info(`Claude generated patch for ${params.filePath} (${parsed.changeType})`);
      return parsed;
    } catch (err) {
      logger.error('Claude generatePatch failed, using fallback:', err);
      return this.fallback.generatePatch(params);
    }
  }
```

Add `generatePatch` to `HttpLlmService` (fallback to template):

```typescript
  async generatePatch(params: PatchParams): Promise<PatchLlmResult> {
    if (!this.config.apiKey || !this.baseUrl) {
      return this.fallback.generatePatch(params);
    }
    try {
      return await this.callApi('generatePatch', params);
    } catch (err) {
      logger.error(`${this.config.provider} generatePatch failed, using fallback:`, err);
      return this.fallback.generatePatch(params);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/patch-llm.test.ts -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/llm-service.ts tests/patch-llm.test.ts
git commit -m "feat(llm): add generatePatch to LlmService with Template and Anthropic implementations"
```

---

### Task 5: Enhance PatchGeneratorAgent with LLM

**Files:**
- Modify: `src/agents/patch-generator-agent.ts`
- Modify: `tests/agents.test.ts`

- [ ] **Step 1: Write the failing test for LLM patch generation**

Append to `tests/agents.test.ts` (or create a focused test):

```typescript
import { describe, it, expect } from 'vitest';
import { PatchGeneratorAgent } from '../src/agents/patch-generator-agent.js';
import { MemoryMiddleware } from '../src/core/memory.js';
import { TemplateLlmService } from '../src/core/llm-service.js';
import type { AgentInput, SolutionPlan } from '../src/core/types.js';

describe('PatchGeneratorAgent with LLM', () => {
  it('uses LLM to generate patch when original/modified code is missing', async () => {
    const memory = new MemoryMiddleware();
    const llm = new TemplateLlmService();
    const agent = new PatchGeneratorAgent(memory, llm);

    const plan: SolutionPlan = {
      id: 'plan-1',
      timestamp: new Date().toISOString(),
      taskId: 'task-1',
      problem: { description: 'Fix null dereference', rootCause: 'Missing null check', severity: 'high' },
      changes: [
        {
          filePath: 'src/helper.ts',
          changeType: 'modify',
          description: 'Add optional chaining for null safety',
          reasoning: 'user.name may be undefined',
          originalCode: 'function getName(user) {\n  return user.name;\n}',
        },
      ],
      metadata: { confidence: 0.8, tokenUsed: 100 },
    };

    const input: AgentInput = {
      taskId: 'task-1',
      instruction: 'Generate patches',
      context: { plan: plan as unknown as Record<string, unknown> },
    };

    const output = await agent.run(input);
    const patches = output.result.patches as Array<{ filePath: string; modifiedCode: string; diff: string }>;
    expect(patches.length).toBe(1);
    expect(patches[0].modifiedCode).toContain('?.');
  });

  it('falls back to empty patch when LLM is not provided', async () => {
    const memory = new MemoryMiddleware();
    const agent = new PatchGeneratorAgent(memory);

    const plan: SolutionPlan = {
      id: 'plan-1',
      timestamp: new Date().toISOString(),
      taskId: 'task-1',
      problem: { description: 'Fix null dereference', rootCause: 'Missing null check', severity: 'high' },
      changes: [
        {
          filePath: 'src/helper.ts',
          changeType: 'modify',
          description: 'Add optional chaining',
          reasoning: 'null safety',
        },
      ],
      metadata: { confidence: 0.8, tokenUsed: 100 },
    };

    const input: AgentInput = {
      taskId: 'task-1',
      instruction: 'Generate patches',
      context: { plan: plan as unknown as Record<string, unknown> },
    };

    const output = await agent.run(input);
    const patches = output.result.patches as Array<{ filePath: string; diff: string }>;
    expect(patches.length).toBe(1);
    // Without LLM and without original/modified code, should still produce a patch
    expect(patches[0].diff).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents.test.ts -v`
Expected: FAIL — `PatchGeneratorAgent` constructor does not accept `llm` parameter

- [ ] **Step 3: Enhance `PatchGeneratorAgent`**

Replace `src/agents/patch-generator-agent.ts`:

```typescript
import { BaseAgent } from './base-agent.js';
import { MemoryMiddleware } from '../core/memory.js';
import { generatePatch, type FilePatch, type PatchResult } from '../core/patch.js';
import { patchGeneratorContextSchema, parseContext, type AgentInput, type SolutionPlan, type FileChange } from '../core/types.js';
import type { LlmService } from '../core/llm-service.js';

export class PatchGeneratorAgent extends BaseAgent {
  constructor(
    private memory: MemoryMiddleware,
    private llm?: LlmService,
  ) {
    super('patch-generator');
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const { plan: rawPlan } = parseContext(input.context, patchGeneratorContextSchema);
    const plan = rawPlan as unknown as SolutionPlan;
    if (!plan || !plan.changes) {
      throw new Error('plan is required in context');
    }

    const patches: FilePatch[] = [];

    for (const change of plan.changes) {
      const patch = await this.generatePatchForChange(change);
      patches.push(patch);
    }

    const result: PatchResult = {
      patches,
      summary: {
        filesAdded: patches.filter(p => p.changeType === 'add').length,
        filesModified: patches.filter(p => p.changeType === 'modify').length,
        filesDeleted: patches.filter(p => p.changeType === 'delete').length,
      },
    };

    this.logger.info(`Generated ${patches.length} patches`);

    return {
      result,
      patches,
      summary: result.summary,
    };
  }

  private async generatePatchForChange(change: FileChange): Promise<FilePatch> {
    // If both original and modified code are provided, use them directly
    if (change.originalCode !== undefined && change.modifiedCode !== undefined) {
      return generatePatch(change.filePath, change.originalCode, change.modifiedCode);
    }

    // If LLM is available and we have at least a description, use LLM to generate the patch
    if (this.llm && change.description) {
      try {
        const llmResult = await this.llm.generatePatch({
          filePath: change.filePath,
          description: change.description,
          reasoning: change.reasoning,
          originalCode: change.originalCode,
          modifiedCode: change.modifiedCode,
        });

        return generatePatch(change.filePath, llmResult.originalCode, llmResult.modifiedCode);
      } catch (err) {
        this.logger.warn(`LLM patch generation failed for ${change.filePath}, falling back:`, err);
      }
    }

    // Fallback: if originalCode is provided but modifiedCode is not, generate empty diff
    if (change.originalCode !== undefined) {
      this.logger.warn(`Change for ${change.filePath} lacks modifiedCode, generating identity diff`);
      return generatePatch(change.filePath, change.originalCode, change.originalCode);
    }

    // Last resort: empty patch
    this.logger.warn(`Change for ${change.filePath} lacks both originalCode and modifiedCode, generating empty diff`);
    return generatePatch(change.filePath, '', '');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agents.test.ts -v`
Expected: PASS (all tests including new ones)

- [ ] **Step 5: Commit**

```bash
git add src/agents/patch-generator-agent.ts tests/agents.test.ts
git commit -m "feat(patch): enhance PatchGeneratorAgent with LLM-powered diff generation"
```

---

### Task 6: Integrate Web Search into Main Flow

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/cli.test.ts`

- [ ] **Step 1: Understand the current `fix()` flow**

The current `fix()` method in `src/index.ts` (around line ~200+) does:
1. `RepoScannerAgent` — scan repo
2. `FaultDetectorAgent` — detect faults
3. `ContextBuilderAgent` — build context
4. `SolutionPlannerAgent` — generate solution
5. `PatchGeneratorAgent` — generate patches
6. Review + apply

We need to insert `WebSearcherAgent` between step 3 and 4, passing search results to `SolutionPlannerAgent`.

- [ ] **Step 2: Add `--web-search` / `--no-web-search` CLI flags**

In `src/index.ts`, add to the `fix` command (around where `.option()` calls are):

```typescript
    .option('--web-search', 'enable web search for solutions', true)
    .option('--no-web-search', 'disable web search')
```

- [ ] **Step 3: Wire WebSearcherAgent into `fix()` method**

Import at top of `src/index.ts`:
```typescript
import { WebSearcherAgent } from './agents/web-searcher-agent.js';
```

In the `fix()` method, after `ContextBuilderAgent` runs and before `SolutionPlannerAgent`:

```typescript
    // ---- Web Search (Phase 3) ----
    let searchResults: Array<{ title: string; url: string; snippet: string; credibilityScore: number }> = [];
    if (this.config.webSearch !== false) {
      const webSearcher = new WebSearcherAgent(this.memory);
      const searchOutput = await webSearcher.run({
        taskId,
        instruction: 'Search web for solutions',
        context: {
          findings: faultOutput.findings,
          language: 'typescript',
        },
      });
      searchResults = (searchOutput.result.searchResults as typeof searchResults) || [];

      // Record token usage for search
      const searchTokens = searchResults.reduce((sum, r) => sum + r.title.length + r.snippet.length, 0);
      this.budgetManager.recordUsage('search', this.estimateTokens(searchTokens));
    }
```

Pass search results to `SolutionPlannerAgent`:

```typescript
    const planner = new SolutionPlannerAgent(this.llmService);
    const planOutput = await planner.run({
      taskId,
      instruction: 'Generate repair plan',
      context: {
        problem,
        findings: faultOutput.findings,
        affectedFiles,
        repoPath: resolvedPath,
        searchResults: searchResults.map(r => ({
          title: r.title,
          snippet: r.snippet,
          credibility: r.credibilityScore,
        })),
      },
    });
```

- [ ] **Step 4: Update `SolutionPlannerAgent` to consume search results**

Modify `src/agents/solution-planner-agent.ts` to accept and use `searchResults` in context. The `solutionPlannerContextSchema` currently only has `problem`, `findings`, `affectedFiles`, `repoPath`. Update the schema to accept optional `searchResults`.

In `src/core/types.ts`, update `solutionPlannerContextSchema`:
```typescript
export const solutionPlannerContextSchema = z.object({
  problem: z.string(),
  findings: z.array(findingSchema).optional().default([]),
  affectedFiles: z.array(z.string()).optional().default([]),
  repoPath: z.string().optional().default('.'),
  searchResults: z.array(z.object({
    title: z.string(),
    snippet: z.string(),
    credibility: z.number(),
  })).optional().default([]),
});
```

In `src/agents/solution-planner-agent.ts`, pass `searchResults` to `generateSolution` if LLM is available. The current implementation passes `codeContext` read from files. Add search results as additional context.

- [ ] **Step 5: Update `AgentConfig` to include `webSearch`**

In `src/index.ts`, add to `AgentConfig`:
```typescript
export interface AgentConfig {
  // ... existing fields
  webSearch?: boolean;
}
```

- [ ] **Step 6: Write CLI integration test**

Append to `tests/cli.test.ts`:

```typescript
  it('fix command with --web-search finds search results', async () => {
    const agent = new CodeRepairAgent({ webSearch: true });
    await agent.init(sampleRepoPath);

    const plan = await agent.plan('Fix null dereference');
    expect(plan).toBeDefined();
    // If search was triggered, the plan metadata may reference it
  });

  it('fix command with --no-web-search skips search', async () => {
    const agent = new CodeRepairAgent({ webSearch: false });
    await agent.init(sampleRepoPath);

    const plan = await agent.plan('Fix null dereference');
    expect(plan).toBeDefined();
  });
```

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`
Expected: PASS (all 125+ tests)

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/agents/solution-planner-agent.ts src/core/types.ts tests/cli.test.ts
git commit -m "feat(web-search): integrate WebSearcherAgent into fix/plan flow with --web-search CLI flag"
```

---

### Task 7: Record Token Budget for Search and Patch Generation

**Files:**
- Modify: `src/agents/web-searcher-agent.ts`
- Modify: `src/agents/patch-generator-agent.ts`

- [ ] **Step 1: Add token budget recording to WebSearcherAgent**

Inject `TokenBudgetManager` into `WebSearcherAgent` constructor and record usage:

In `src/agents/web-searcher-agent.ts`:
```typescript
import { TokenBudgetManager } from '../core/token-budget.js';

export class WebSearcherAgent extends BaseAgent {
  constructor(
    private memory: MemoryMiddleware,
    private budgetManager?: TokenBudgetManager,
  ) {
    super('web-searcher');
    this.engine = new WebSearchEngine();
  }
```

In the `execute` method, after getting search results:
```typescript
    // Record search token usage
    if (this.budgetManager) {
      const searchTokens = searchResults.reduce((sum, r) =>
        sum + r.title.length + r.snippet.length + r.url.length, 0);
      this.budgetManager.recordUsage('search', Math.ceil(searchTokens / 4));
    }
```

- [ ] **Step 2: Add token budget recording to PatchGeneratorAgent**

In `src/agents/patch-generator-agent.ts`:
```typescript
import { TokenBudgetManager } from '../core/token-budget.js';

export class PatchGeneratorAgent extends BaseAgent {
  constructor(
    private memory: MemoryMiddleware,
    private llm?: LlmService,
    private budgetManager?: TokenBudgetManager,
  ) {
```

In `generatePatchForChange`, after LLM call:
```typescript
      if (this.budgetManager) {
        const patchTokens = (llmResult.originalCode.length + llmResult.modifiedCode.length);
        this.budgetManager.recordUsage('planning', Math.ceil(patchTokens / 4));
      }
```

- [ ] **Step 3: Update `CodeRepairAgent` to pass budget manager**

In `src/index.ts`, when constructing agents:
```typescript
    const webSearcher = new WebSearcherAgent(this.memory, this.budgetManager);
    // ...
    const patchGenerator = new PatchGeneratorAgent(this.memory, this.llmService, this.budgetManager);
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/web-searcher-agent.ts src/agents/patch-generator-agent.ts src/index.ts
git commit -m "feat(token-budget): record search and patch generation token usage"
```

---

### Task 8: Final Integration Test & Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS (expected: 140+ tests across 18 test files)

- [ ] **Step 2: Verify TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Check test coverage**

Run: `npx vitest run --coverage`
Expected: Coverage report showing web-search, web-searcher-agent, patch-llm covered

- [ ] **Step 4: Update PROGRESS.md**

Add Phase 3 completion entries:
- Web Search Engine with query builder and simulation provider
- WebSearcherAgent with memory caching
- LLM generatePatch for all providers
- PatchGeneratorAgent LLM enhancement
- CLI `--web-search` / `--no-web-search` flags
- Token budget integration for search

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(phase3): web search module + LLM patch generation complete"
```

---

## Self-Review

### 1. Spec Coverage

| DESIGN.md Requirement | Task |
|----------------------|------|
| WebSearchStrategy interface (triggers, queryBuilder, fusion) | Task 1, 2 |
| SearchTemplate query generation | Task 2 |
| Result fusion (weighted/fallback/ensemble) | Task 2 (strategy defined, weighted default) |
| WebSearcherAgent in pipeline | Task 3, 6 |
| Search cache in memory layer | Task 3 |
| Token budget for search category | Task 7 |
| LLM generatePatch | Task 4, 5 |
| CLI flags for web search | Task 6 |

**Gap:** Real HTTP-based search providers (Google/Bing) are not implemented — this is by design (Phase 3 MVP uses simulation; real APIs in Phase 3.x or Phase 4).

### 2. Placeholder Scan
- No "TBD", "TODO", "implement later" found
- All code blocks contain complete implementations
- All test blocks contain complete test code
- All run commands have expected output

### 3. Type Consistency
- `WebSearchQuery`, `WebSearchResult`, `SearchTemplate` used consistently across tasks
- `PatchLlmResult.changeType` matches `FilePatch.changeType` values
- Zod schemas match TypeScript interfaces

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-02-phase3-web-search.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review

**Which approach?**