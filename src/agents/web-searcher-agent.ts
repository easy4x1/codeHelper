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

    // Convert search results to findings for downstream agents
    const searchFindings = searchResults.map((r, i) => ({
      id: `search-${i}`,
      type: 'insight' as const,
      description: `[${r.source}] ${r.title}: ${r.snippet}`,
      confidence: r.credibilityScore,
      nodeIds: [],
    }));

    return {
      searchResults,
      skipped: false,
      query: errorMessage,
      findings: searchFindings,
    };
  }
}
