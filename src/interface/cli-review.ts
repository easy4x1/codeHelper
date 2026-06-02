import type { FilePatch, PatchResult } from '../core/patch.js';

export type ReviewDecision = 'approve' | 'reject' | 'edit';

export interface ReviewOptions {
  autoApprove?: boolean;     // For non-interactive mode (CI/testing)
  diffSizeLimit?: number;    // Max lines per diff before truncation
}

export function formatDiff(patch: FilePatch): string {
  const lines: string[] = [];

  // Header
  const action =
    patch.changeType === 'add' ? 'Added' :
    patch.changeType === 'delete' ? 'Deleted' :
    'Modified';
  lines.push(`\n${action}: ${patch.filePath}`);
  lines.push('─'.repeat(60));

  // Show the diff
  if (patch.diff) {
    const diffLines = patch.diff.split('\n');
    for (const line of diffLines) {
      if (line.startsWith('+')) {
        lines.push(`\x1b[32m${line}\x1b[0m`);  // Green for additions
      } else if (line.startsWith('-')) {
        lines.push(`\x1b[31m${line}\x1b[0m`);  // Red for deletions
      } else {
        lines.push(line);
      }
    }
  }

  // Show full before/after for small files (MVP: always show)
  if (patch.changeType === 'modify') {
    lines.push('\n  Original:');
    lines.push('  ' + (patch.originalCode || '').split('\n').join('\n  '));
    lines.push('\n  Modified:');
    lines.push('  ' + (patch.modifiedCode || '').split('\n').join('\n  '));
  }

  lines.push('─'.repeat(60));

  return lines.join('\n');
}

export function formatPatchResult(result: PatchResult): string {
  const lines: string[] = [
    '\n=== Patch Summary ===',
    `Files modified: ${result.summary.filesModified}`,
    `Files added: ${result.summary.filesAdded}`,
    `Files deleted: ${result.summary.filesDeleted}`,
    '',
  ];
  return lines.join('\n');
}

export function createReviewPrompt(): string {
  return '\nReview this change. Options: approve, reject, edit > ';
}
