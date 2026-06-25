import { BaseAgent } from './base-agent.js';
import { GitExecutor, type GitExecutionConfig, type GitExecutionResult } from '../core/git-executor.js';
import type { AgentInput } from '../core/types.js';

export class GitExecutorAgent extends BaseAgent {
  private executor: GitExecutor;

  constructor(config?: Partial<GitExecutionConfig>) {
    super('git-executor');
    this.executor = new GitExecutor(config);
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const files = Array.isArray(input.context.files) ? input.context.files as string[] : [];
    const description = typeof input.context.description === 'string' ? input.context.description : 'code-agent fix';

    this.logger.info(`Executing git workflow for ${files.length} file(s)`);

    const result = await this.executor.execute(files, description);

    return {
      result,
      success: result.success,
      branch: result.branch,
      commitHash: result.commitHash,
      pushed: result.pushed,
      prUrl: result.prUrl,
      messages: result.messages,
      errors: result.errors,
    };
  }

  async getStatus() {
    return this.executor.getStatus();
  }
}
