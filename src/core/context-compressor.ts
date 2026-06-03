import type { FileFingerprint } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('context-compressor');

/**
 * ContextCompressor — replaces full file content with structural summaries
 * when passing code to LLM for analysis.
 *
 * For small files (< threshold lines), full content is preserved.
 * For large files, only function signatures, class skeletons, and imports
 * are included — enough for the LLM to understand structure without
 * consuming tokens on implementation details.
 *
 * Expected savings: 50-70% for large files.
 */
export class ContextCompressor {
  /** Files below this line count are passed through unchanged. */
  private readonly thresholdLines = 30;

  compress(filePath: string, content: string, fingerprint: FileFingerprint | undefined): string {
    // No fingerprint available — can't compress, return full content
    if (!fingerprint) {
      logger.info(`No fingerprint for ${filePath}, returning full content`);
      return content;
    }

    // Small file — full content is already efficient
    if (fingerprint.totalLines <= this.thresholdLines) {
      return content;
    }

    // Large file — generate structural summary
    const summary = this.buildSummary(filePath, fingerprint);
    const savings = Math.round((1 - summary.length / content.length) * 100);
    logger.info(`Compressed ${filePath}: ${fingerprint.totalLines} lines → summary (${savings}% savings)`);
    return summary;
  }

  private buildSummary(filePath: string, fp: FileFingerprint): string {
    const parts: string[] = [];
    parts.push(`// Structural summary of ${filePath}`);
    parts.push('');

    // Imports
    if (fp.imports.length > 0) {
      for (const imp of fp.imports) {
        if (imp.isDefault && imp.items[0]) {
          parts.push(`import ${imp.items[0]} from '${imp.source}';`);
        } else if (imp.items.length > 0) {
          parts.push(`import { ${imp.items.join(', ')} } from '${imp.source}';`);
        } else {
          parts.push(`import '${imp.source}';`);
        }
      }
      parts.push('');
    }

    // Functions
    if (fp.functions.length > 0) {
      for (const fn of fp.functions) {
        const exportPrefix = fn.isExported ? 'export ' : '';
        const paramStr = fn.params?.join(', ') ?? '';
        const returnStr = fn.returnType ? `: ${fn.returnType}` : '';
        parts.push(`${exportPrefix}function ${fn.name}(${paramStr})${returnStr};`);
      }
      parts.push('');
    }

    // Classes
    if (fp.classes.length > 0) {
      for (const cls of fp.classes) {
        const exportPrefix = cls.isExported ? 'export ' : '';
        parts.push(`${exportPrefix}class ${cls.name} {`);
        if (cls.properties && cls.properties.length > 0) {
          parts.push(`  // Properties: ${cls.properties.join(', ')}`);
        }
        if (cls.methods && cls.methods.length > 0) {
          parts.push(`  // Methods: ${cls.methods.join(', ')}`);
        }
        parts.push('}');
      }
      parts.push('');
    }

    // Exports
    if (fp.exports.length > 0) {
      const named = fp.exports.filter(e => e.type !== 'default').map(e => e.name);
      const defaultExp = fp.exports.find(e => e.type === 'default');
      if (defaultExp) {
        parts.push(`export default ${defaultExp.name};`);
      }
      if (named.length > 0) {
        parts.push(`export { ${named.join(', ')} };`);
      }
    }

    return parts.join('\n');
  }
}
