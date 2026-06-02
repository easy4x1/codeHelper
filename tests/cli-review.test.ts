import { describe, it, expect } from 'vitest';
import { formatDiff, formatPatchResult, createReviewPrompt, type ReviewDecision } from '../src/interface/cli-review.js';
import type { FilePatch, PatchResult } from '../src/core/patch.js';

describe('formatDiff', () => {
  it('formats a patch with header', () => {
    const patch: FilePatch = {
      filePath: 'src/test.ts',
      changeType: 'modify',
      originalCode: 'old',
      modifiedCode: 'new',
      diff: '- old\n+ new',
    };
    const formatted = formatDiff(patch);
    expect(formatted).toContain('src/test.ts');
    expect(formatted).toContain('- old');
    expect(formatted).toContain('+ new');
  });

  it('formats an added file', () => {
    const patch: FilePatch = {
      filePath: 'src/new.ts',
      changeType: 'add',
      originalCode: undefined,
      modifiedCode: 'export const x = 1;',
      diff: '',
    };
    const formatted = formatDiff(patch);
    expect(formatted).toContain('Added: src/new.ts');
  });

  it('formats a deleted file', () => {
    const patch: FilePatch = {
      filePath: 'src/old.ts',
      changeType: 'delete',
      originalCode: 'export const old = true;',
      modifiedCode: undefined,
      diff: '',
    };
    const formatted = formatDiff(patch);
    expect(formatted).toContain('Deleted: src/old.ts');
  });
});

describe('formatPatchResult', () => {
  it('formats summary', () => {
    const result: PatchResult = {
      patches: [],
      summary: { filesAdded: 1, filesModified: 2, filesDeleted: 0 },
    };
    const formatted = formatPatchResult(result);
    expect(formatted).toContain('Files modified: 2');
    expect(formatted).toContain('Files added: 1');
    expect(formatted).toContain('Files deleted: 0');
  });
});

describe('createReviewPrompt', () => {
  it('returns the review prompt string', () => {
    const prompt = createReviewPrompt();
    expect(prompt).toContain('approve');
    expect(prompt).toContain('reject');
    expect(prompt).toContain('edit');
  });
});
