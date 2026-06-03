import { BaseAgent } from './base-agent.js';
import { MemoryMiddleware } from '../core/memory.js';
import { TemplateLlmService, type LlmService } from '../core/llm-service.js';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { rootCauseAnalyzerContextSchema, parseContext, type AgentInput, type Finding } from '../core/types.js';

/**
 * Root Cause Analyzer Agent
 *
 * Responsibility: Comprehensive root cause analysis based on findings,
 * code context, search results, and propagation analysis.
 *
 * Input: problem description, findings, code context, search results, propagation result
 * Output: root cause, severity, confidence, affected files
 *
 * DESIGN.md §2.2: Dedicated Agent for root cause analysis,
 * separated from SolutionPlanner for single-responsibility.
 */
export class RootCauseAnalyzerAgent extends BaseAgent {
  private llmService: LlmService;

  constructor(
    private memory: MemoryMiddleware,
    llmService?: LlmService
  ) {
    super('root-cause-analyzer');
    this.llmService = llmService ?? new TemplateLlmService();
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const { problem, findings, codeContext, searchResults, propagationResult } =
      parseContext(input.context, rootCauseAnalyzerContextSchema);

    this.logger.info(`Analyzing root cause for ${findings.length} finding(s)`);

    // Load code context for affected files if not provided
    const enrichedCodeContext = codeContext.length > 0
      ? codeContext
      : await this.loadCodeContext(findings);

    // Phase 1: Propagation-based upstream-most candidate analysis
    const propagationInsights = this.analyzePropagation(propagationResult);

    // Phase 2: LLM-powered root cause analysis
    const llmFindings = findings.map(f => ({
      description: f.description,
      confidence: f.confidence,
      filePath: f.nodeIds?.[0],
      type: f.type === 'fault' ? 'bug' as const : 'style' as const,
    }));

    const llmResult = await this.llmService.analyzeRootCause({
      problem,
      findings: llmFindings,
      codeContext: enrichedCodeContext,
      searchResults: searchResults.map(r => ({
        title: r.title,
        snippet: r.snippet,
        credibility: r.credibility,
      })),
    });

    // Merge propagation insights with LLM result
    const affectedFiles = [...new Set([
      ...llmResult.affectedFiles,
      ...propagationInsights.affectedFiles,
    ])];

    this.logger.info(
      `Root cause identified: ${llmResult.severity} severity, ${affectedFiles.length} affected file(s)`
    );

    return {
      rootCause: llmResult.rootCause,
      severity: llmResult.severity,
      confidence: llmResult.confidence,
      affectedFiles,
      propagationInsights: propagationInsights.insights,
    };
  }

  private async loadCodeContext(
    findings: Finding[]
  ): Promise<Array<{ filePath: string; code: string }>> {
    const filePaths = [...new Set(findings.map(f => f.nodeIds?.[0]).filter(Boolean))] as string[];
    const contexts: Array<{ filePath: string; code: string }> = [];

    for (const filePath of filePaths) {
      try {
        const content = await readFile(resolve(filePath), 'utf-8');
        contexts.push({ filePath, code: content });
      } catch {
        // File may not exist or be readable
        contexts.push({ filePath, code: '' });
      }
    }

    return contexts;
  }

  private analyzePropagation(propagationResult?: Record<string, unknown>): {
    affectedFiles: string[];
    insights: string[];
  } {
    if (!propagationResult) {
      return { affectedFiles: [], insights: [] };
    }

    const affectedNodes = (propagationResult.affectedNodes || []) as Array<{
      nodeId: string;
      nodeType: string;
      impactProbability: number;
    }>;

    const rootCauseCandidates = (propagationResult.rootCauseCandidates || []) as Array<{
      nodeId: string;
      confidence: number;
    }>;

    const affectedFiles = [...new Set(
      affectedNodes.map(n => {
        // Extract file path from nodeId (format: type:path:name)
        const parts = n.nodeId.split(':');
        return parts.length >= 2 ? parts.slice(1, -1).join(':') || parts[1] : n.nodeId;
      }).filter(Boolean)
    )];

    const insights: string[] = [];

    if (rootCauseCandidates.length > 0) {
      const topCandidate = rootCauseCandidates[0];
      insights.push(`Top root cause candidate: ${topCandidate.nodeId} (confidence: ${(topCandidate.confidence * 100).toFixed(0)}%)`);
    }

    if (affectedNodes.length > 0) {
      const highImpact = affectedNodes.filter(n => n.impactProbability > 0.7);
      if (highImpact.length > 0) {
        insights.push(`${highImpact.length} high-impact node(s) identified via propagation analysis`);
      }
    }

    return { affectedFiles, insights };
  }
}
