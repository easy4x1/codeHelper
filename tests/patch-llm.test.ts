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
