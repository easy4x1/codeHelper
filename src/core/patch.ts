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

  // For modify, try exact match first, then fuzzy match
  if (currentContent !== undefined && patch.originalCode !== undefined) {
    if (currentContent === patch.originalCode) {
      return patch.modifiedCode || '';
    }

    // Fuzzy match: try to locate the original code block within the current file
    if (currentContent.includes(patch.originalCode)) {
      return currentContent.replace(patch.originalCode, patch.modifiedCode || '');
    }

    throw new Error(
      `Patch conflict: ${patch.filePath} has changed since the patch was generated. ` +
      `Could not find the expected code block.`
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
