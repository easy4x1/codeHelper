import type { AgentInput, AgentOutput, Finding } from '../core/types.js';
import { createLogger, type Logger } from '../utils/logger.js';

export abstract class BaseAgent {
  protected logger: Logger;

  constructor(public readonly name: string) {
    this.logger = createLogger(name);
  }

  async run(input: AgentInput): Promise<AgentOutput> {
    this.logger.info(`Starting execution for task ${input.taskId}`);
    const startTime = Date.now();

    try {
      const result = await this.execute(input);
      const duration = Date.now() - startTime;

      this.logger.info(`Completed in ${duration}ms`);

      // Extract findings safely
      const findings = Array.isArray(result.findings) ? result.findings : [];

      // Remove findings from result to avoid duplication
      const { findings: _, ...resultWithoutFindings } = result;

      return {
        taskId: input.taskId,
        agentName: this.name,
        result: {
          ...resultWithoutFindings,
          _meta: {
            durationMs: duration,
            timestamp: new Date().toISOString(),
          },
        },
        findings,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`Failed after ${duration}ms:`, error);
      throw error;
    }
  }

  protected abstract execute(input: AgentInput): Promise<Record<string, unknown>>;
}
