import { createHash } from '../utils/hash.js';
import type {
  FileFingerprint,
  FunctionSignature,
  ClassSignature,
  ImportSignature,
  ExportSignature,
  ChangeLevel,
  ChangeAnalysis,
} from './types.js';

export function computeFingerprint(filePath: string, content: string): FileFingerprint {
  const lines = content.split('\n');
  const functions = extractFunctions(content);
  const classes = extractClasses(content);
  const imports = extractImports(content);
  const exports = extractExports(content);

  return {
    filePath,
    contentHash: createHash(content),
    functions,
    classes,
    imports,
    exports,
    totalLines: lines.length,
    hasStructuralAnalysis: true,
  };
}

function extractFunctions(content: string): FunctionSignature[] {
  const functions: FunctionSignature[] = [];
  const lines = content.split('\n');

  // Pattern: export? async? function name(params) { ... }
  const funcRegex = /^(export\s+)?(async\s+)?function\s+(\w+)\s*\(([^)]*)\)/;
  // Pattern: const name = (params) => { ... }
  const arrowRegex = /^(export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/;
  // Pattern: const name = async function(params) { ... }
  const asyncFuncRegex = /^(export\s+)?const\s+(\w+)\s*=\s*async\s+function\s*\(([^)]*)\)/;

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    let match = line.match(funcRegex);
    if (match) {
      functions.push({
        name: match[3],
        params: match[4].split(',').map(p => p.trim()).filter(Boolean),
        isExported: !!match[1],
        startLine: lineNum,
        endLine: lineNum,
      });
      return;
    }
    match = line.match(arrowRegex);
    if (match) {
      functions.push({
        name: match[2],
        params: match[3].split(',').map(p => p.trim()).filter(Boolean),
        isExported: !!match[1],
        startLine: lineNum,
        endLine: lineNum,
      });
      return;
    }
    match = line.match(asyncFuncRegex);
    if (match) {
      functions.push({
        name: match[2],
        params: match[3].split(',').map(p => p.trim()).filter(Boolean),
        isExported: !!match[1],
        startLine: lineNum,
        endLine: lineNum,
      });
    }
  });

  return functions;
}

function extractClasses(content: string): ClassSignature[] {
  const classes: ClassSignature[] = [];
  const lines = content.split('\n');
  const classRegex = /^(export\s+)?class\s+(\w+)/;

  lines.forEach((line, idx) => {
    const match = line.match(classRegex);
    if (match) {
      classes.push({
        name: match[2],
        methods: [],
        properties: [],
        isExported: !!match[1],
        startLine: idx + 1,
        endLine: idx + 1,
      });
    }
  });

  return classes;
}

function extractImports(content: string): ImportSignature[] {
  const imports: ImportSignature[] = [];
  const lines = content.split('\n');
  const importRegex = /import\s+(?:(\{[^}]+\})|(\w+))\s+from\s+['"]([^'"]+)['"]/;

  lines.forEach((line, idx) => {
    const match = line.match(importRegex);
    if (match) {
      const items = match[1]
        ? match[1].replace(/[{}]/g, '').split(',').map(s => s.trim()).filter(Boolean)
        : match[2]
          ? [match[2]]
          : [];
      imports.push({
        source: match[3],
        items,
        isDefault: !!match[2],
        line: idx + 1,
      });
    }
  });

  return imports;
}

function extractExports(content: string): ExportSignature[] {
  const exports: ExportSignature[] = [];
  const lines = content.split('\n');
  const exportRegex = /^export\s+(?:default\s+)?(?:(?:async\s+)?function|class|const|let|var|type|interface)\s+(\w+)/;
  const defaultRegex = /^export\s+default\s+(\w+)/;

  lines.forEach((line, idx) => {
    let match = line.match(exportRegex);
    if (match) {
      const type: ExportSignature['type'] = line.includes('function')
        ? 'function'
        : line.includes('class')
          ? 'class'
          : 'variable';
      exports.push({ name: match[1], type, line: idx + 1 });
      return;
    }
    match = line.match(defaultRegex);
    if (match) {
      exports.push({ name: match[1], type: 'default', line: idx + 1 });
    }
  });

  return exports;
}

export function classifyChange(
  oldFp: FileFingerprint | null,
  newFp: FileFingerprint
): ChangeAnalysis {
  if (!oldFp) {
    return { filePath: newFp.filePath, changeLevel: 'STRUCTURAL', details: ['New file'] };
  }

  if (oldFp.contentHash === newFp.contentHash) {
    return { filePath: newFp.filePath, changeLevel: 'NONE', details: ['No changes'] };
  }

  const details: string[] = [];

  if (!signaturesEqual(oldFp.functions, newFp.functions)) {
    details.push('Function signatures changed');
  }
  if (!signaturesEqual(oldFp.classes, newFp.classes)) {
    details.push('Class signatures changed');
  }
  if (!signaturesEqual(oldFp.imports, newFp.imports)) {
    details.push('Import signatures changed');
  }
  if (!signaturesEqual(oldFp.exports, newFp.exports)) {
    details.push('Export signatures changed');
  }

  const changeLevel: ChangeLevel = details.length > 0 ? 'STRUCTURAL' : 'COSMETIC';

  return { filePath: newFp.filePath, changeLevel, details };
}

function signaturesEqual<T extends object>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  const serialize = (x: T) => JSON.stringify(x, Object.keys(x).sort());
  const setA = new Set(a.map(serialize));
  const setB = new Set(b.map(serialize));
  if (setA.size !== setB.size) return false;
  for (const item of setA) {
    if (!setB.has(item)) return false;
  }
  return true;
}
