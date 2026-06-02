import { BaseAgent } from './base-agent.js';
import { MemoryMiddleware } from '../core/memory.js';
import { generatePatch, type FilePatch, type PatchResult } from '../core/patch.js';
import { patchGeneratorContextSchema, parseContext, type AgentInput, type SolutionPlan, type FileChange } from '../core/types.js';

export class PatchGeneratorAgent extends BaseAgent {
  constructor(private memory: MemoryMiddleware) {
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
    // If the plan already includes original/modified code, use it directly
    if (change.originalCode !== undefined || change.modifiedCode !== undefined) {
      return generatePatch(change.filePath, change.originalCode, change.modifiedCode);
    }

    // Otherwise, read the original from disk and use the description
    // (MVP: we require originalCode/modifiedCode in the plan)
    this.logger.warn(`Change for ${change.filePath} lacks originalCode/modifiedCode, generating empty diff`);
    return generatePatch(change.filePath, '', '');
  }
}
