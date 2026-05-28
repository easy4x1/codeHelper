import type { AgentInput, AgentOutput, Finding } from '../core/types.js';
import { createLogger } from '../utils/logger.js';

export abstract class BaseAgent {
  protected logger = createLogger(this.name);

  constructor(public readonly name: string) {}

  async run(input: AgentInput): Promise<AgentOutput> {
    this.logger.info(`Starting execution for task ${input.taskId}`);
    const startTime = Date.now();

    try {
      const result = await this.execute(input);
      const duration = Date.now() - startTime;

      this.logger.info(`Completed in ${duration}ms`);

      return {
        taskId: input.taskId,
        agentName: this.name,
        result: {
          ...result,
          _meta: {
            durationMs: duration,
            timestamp: new Date().toISOString(),
          },
        },
        findings: (result.findings as Finding[] | undefined) || [],
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`Failed after ${duration}ms:`, error);
      throw error;
    }
  }

  protected abstract execute(input: AgentInput): Promise<Record<string, unknown>>;
}
