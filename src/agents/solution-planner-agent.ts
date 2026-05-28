import { BaseAgent } from './base-agent.js';
import { MemoryMiddleware } from '../core/memory.js';
import type { AgentInput, SolutionPlan, FileChange, Finding } from '../core/types.js';

export class SolutionPlannerAgent extends BaseAgent {
  constructor(private memory: MemoryMiddleware) {
    super('solution-planner');
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const problem = input.context.problem as string || 'Unknown issue';
    const findings = (input.context.findings as Finding[] || []) as Finding[];
    const affectedFiles = input.context.affectedFiles as string[] || [];

    const changes: FileChange[] = affectedFiles.map(filePath => ({
      filePath,
      changeType: 'modify',
      description: `Review and fix issues in ${filePath}`,
      reasoning: `File identified as part of the problem scope`,
    }));

    const plan: SolutionPlan = {
      id: `plan-${input.taskId}`,
      timestamp: new Date().toISOString(),
      taskId: input.taskId,
      problem: {
        description: problem,
        rootCause: findings.length > 0
          ? findings.map(f => f.description).join('; ')
          : 'Root cause analysis pending',
        severity: 'medium',
      },
      changes,
      metadata: {
        confidence: findings.length > 0 ? 0.7 : 0.3,
        tokenUsed: 0,
      },
    };

    return {
      plan,
      changeCount: changes.length,
    };
  }
}
