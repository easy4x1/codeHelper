import { readdir, readFile, stat } from 'fs/promises';
import { join, relative, extname } from 'path';
import { computeFingerprint } from './fingerprint.js';
import type { FileFingerprint } from './types.js';

export interface ScanResult {
  files: { filePath: string; absolutePath: string }[];
  fingerprints: FileFingerprint[];
  languages: Set<string>;
  skippedFiles: string[];
}

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs', '.rb', '.php',
  '.cpp', '.c', '.h', '.hpp', '.cs', '.swift',
  '.kt', '.scala', '.sh', '.bash',
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out',
  'coverage', '.nyc_output', '.cache', '.tmp',
  'vendor', '.venv', 'venv', '__pycache__',
]);

const IGNORED_FILES = new Set([
  '.DS_Store', 'package-lock.json', 'yarn.lock',
  'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock',
]);

export async function scanRepo(repoPath: string): Promise<ScanResult> {
  const files: { filePath: string; absolutePath: string }[] = [];
  const languages = new Set<string>();
  const skippedFiles: string[] = [];

  await walkDir(repoPath, repoPath, files, languages, skippedFiles);

  const fingerprints: FileFingerprint[] = [];
  await Promise.all(
    files.map(async (file) => {
      try {
        const content = await readFile(file.absolutePath, 'utf-8');
        const fp = computeFingerprint(file.filePath, content);
        fingerprints.push(fp);
      } catch {
        skippedFiles.push(file.filePath);
      }
    })
  );

  return { files, fingerprints, languages, skippedFiles };
}

async function walkDir(
  rootPath: string,
  currentPath: string,
  files: { filePath: string; absolutePath: string }[],
  languages: Set<string>,
  skippedFiles: string[]
): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      skippedFiles.push(relative(rootPath, join(currentPath, entry.name)));
      continue;
    }

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        await walkDir(rootPath, join(currentPath, entry.name), files, languages, skippedFiles);
      }
      continue;
    }

    if (entry.isFile()) {
      if (IGNORED_FILES.has(entry.name)) continue;

      const ext = extname(entry.name);
      if (!SOURCE_EXTENSIONS.has(ext)) continue;

      const absolutePath = join(currentPath, entry.name);
      const filePath = relative(rootPath, absolutePath);
      files.push({ filePath, absolutePath });
      languages.add(ext);
    }
  }
}

export function buildImportMap(fingerprints: FileFingerprint[]): Record<string, string[]> {
  const importMap: Record<string, string[]> = {};
  for (const fp of fingerprints) {
    importMap[fp.filePath] = fp.imports.map(i => i.source);
  }
  return importMap;
}
