export interface FilePatch {
  filePath: string;
  changeType: 'modify' | 'add' | 'delete';
  originalCode?: string;
  modifiedCode?: string;
  diff: string;
}

export interface PatchResult {
  patches: FilePatch[];
  summary: {
    filesAdded: number;
    filesModified: number;
    filesDeleted: number;
  };
}

export function generatePatch(
  filePath: string,
  originalCode: string | undefined,
  modifiedCode: string | undefined
): FilePatch {
  const changeType: FilePatch['changeType'] =
    originalCode === undefined ? 'add' :
    modifiedCode === undefined ? 'delete' :
    'modify';

  const diff = computeDiff(originalCode || '', modifiedCode || '');

  return {
    filePath,
    changeType,
    originalCode,
    modifiedCode,
    diff,
  };
}

export function applyPatch(patch: FilePatch, currentContent?: string): string {
  if (patch.changeType === 'add') {
    return patch.modifiedCode || '';
  }

  if (patch.changeType === 'delete') {
    return '';
  }

  // For modify, verify the current content matches the expected original
  if (currentContent !== undefined && currentContent !== patch.originalCode) {
    throw new Error(
      `Patch conflict: ${patch.filePath} has changed since the patch was generated. ` +
      'Expected:\n' + patch.originalCode + '\nActual:\n' + currentContent
    );
  }

  return patch.modifiedCode || '';
}

function computeDiff(original: string, modified: string): string {
  const origLines = original.split('\n');
  const modLines = modified.split('\n');

  const diff: string[] = [
    `--- ${original ? 'a/' + 'file' : '/dev/null'}`,
    `+++ ${modified ? 'b/' + 'file' : '/dev/null'}`,
  ];

  // Simple line-by-line diff (naive but sufficient for MVP)
  let i = 0;
  while (i < origLines.length || i < modLines.length) {
    const orig = i < origLines.length ? origLines[i] : undefined;
    const mod = i < modLines.length ? modLines[i] : undefined;

    if (orig !== mod) {
      if (orig !== undefined) diff.push(`- ${orig}`);
      if (mod !== undefined) diff.push(`+ ${mod}`);
    }
    i++;
  }

  return diff.join('\n');
}
