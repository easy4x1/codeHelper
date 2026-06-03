import { BaseAgent } from './base-agent.js';
import { MemoryMiddleware } from '../core/memory.js';
import { TemplateLlmService, type LlmService } from '../core/llm-service.js';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { solutionPlannerContextSchema, parseContext, type AgentInput, type SolutionPlan, type FileChange, type Finding } from '../core/types.js';

export class SolutionPlannerAgent extends BaseAgent {
  private llmService: LlmService;

  constructor(
    private memory: MemoryMiddleware,
    llmService?: LlmService
  ) {
    super('solution-planner');
    this.llmService = llmService ?? new TemplateLlmService();
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const { problem, findings, affectedFiles, repoPath, searchResults, rootCause, severity } = parseContext(input.context, solutionPlannerContextSchema);

    // Phase 1: Build code context for affected files
    const codeContext: Array<{ filePath: string; code: string }> = [];
    for (const filePath of affectedFiles) {
      try {
        const content = await readFile(resolve(repoPath, filePath), 'utf-8');
        codeContext.push({ filePath, code: content });
      } catch {
        // File may not exist on disk (e.g., new file)
        codeContext.push({ filePath, code: '' });
      }
    }

    // Phase 2: LLM-powered solution generation
    const llmFindings: Array<{ description: string; confidence: number; filePath?: string; type?: 'bug' | 'style' }> = findings.map(f => ({
      description: f.description,
      confidence: f.confidence,
      filePath: f.nodeIds?.[0],
      type: f.type === 'fault' ? 'bug' as const : 'style' as const,
    }));

    // Append web search results as additional insights
    for (const sr of searchResults) {
      llmFindings.push({
        description: `[Web Search] ${sr.title}: ${sr.snippet}`,
        confidence: sr.credibility,
        filePath: undefined,
        type: 'bug' as const,
      });
    }

    const llmResult = await this.llmService.generateSolution({
      problem,
      findings: llmFindings,
      codeContext,
    });

    // Phase 3: Build FileChange array with originalCode/modifiedCode
    const changes: FileChange[] = [];

    for (const llmChange of llmResult.changes) {
      changes.push({
        filePath: llmChange.filePath,
        changeType: 'modify',
        description: llmChange.description,
        reasoning: llmChange.reasoning,
        originalCode: llmChange.originalCode,
        modifiedCode: llmChange.modifiedCode,
      });
    }

    // Fallback: if LLM didn't generate changes for all affected files, add generic entries
    for (const filePath of affectedFiles) {
      if (!changes.some(c => c.filePath === filePath)) {
        changes.push({
          filePath,
          changeType: 'modify',
          description: `Review and fix issues in ${filePath}`,
          reasoning: `File identified as part of the problem scope`,
        });
      }
    }

    const plan: SolutionPlan = {
      id: `plan-${input.taskId}`,
      timestamp: new Date().toISOString(),
      taskId: input.taskId,
      problem: {
        description: problem,
        rootCause: rootCause || llmResult.rootCause || findings.map(f => f.description).join('; ') || 'Root cause analysis pending',
        severity: (severity as SolutionPlan['problem']['severity']) || llmResult.severity || 'medium',
      },
      changes,
      metadata: {
        confidence: llmResult.confidence || (findings.length > 0 ? 0.7 : 0.3),
        tokenUsed: 0,
      },
    };

    return {
      plan,
      changeCount: changes.length,
    };
  }
}
