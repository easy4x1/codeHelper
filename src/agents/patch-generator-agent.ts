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

    // Fallback: if originalCode is provided but modifiedCode is not, generate identity diff
    if (change.originalCode !== undefined) {
      this.logger.warn(`Change for ${change.filePath} lacks modifiedCode, generating identity diff`);
      return generatePatch(change.filePath, change.originalCode, change.originalCode);
    }

    // Last resort: empty patch
    this.logger.warn(`Change for ${change.filePath} lacks both originalCode and modifiedCode, generating empty diff`);
    return generatePatch(change.filePath, '', '');
  }
}
