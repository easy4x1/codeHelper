import type { FileFingerprint, Convention } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('convention-learner');

/**
 * Learn project conventions from codebase fingerprints.
 *
 * Determines naming patterns, testing conventions, and style rules
 * by analyzing function/class names and file structure.
 */
export class ConventionLearner {
  learnNamingConventions(fingerprints: FileFingerprint[]): Convention[] {
    const conventions: Convention[] = [];

    // Analyze function names
    const functionNames = fingerprints.flatMap(fp => fp.functions.map(f => f.name));
    const classNames = fingerprints.flatMap(fp => fp.classes.map(c => c.name));

    if (functionNames.length > 0) {
      const camelCaseRatio = this.countCamelCase(functionNames) / functionNames.length;
      if (camelCaseRatio > 0.7) {
        conventions.push({
          id: 'conv-func-camelcase',
          category: 'naming',
          rule: 'Functions use camelCase',
          examples: functionNames.filter(n => this.isCamelCase(n)).slice(0, 3),
          confidence: camelCaseRatio,
        });
      }
    }

    if (classNames.length > 0) {
      const pascalCaseRatio = this.countPascalCase(classNames) / classNames.length;
      if (pascalCaseRatio > 0.7) {
        conventions.push({
          id: 'conv-class-pascalcase',
          category: 'naming',
          rule: 'Classes use PascalCase',
          examples: classNames.filter(n => this.isPascalCase(n)).slice(0, 3),
          confidence: pascalCaseRatio,
        });
      }
    }

    return conventions;
  }

  learnTestingConventions(fingerprints: FileFingerprint[]): Convention[] {
    const conventions: Convention[] = [];
    const testFiles = fingerprints.filter(fp => fp.filePath.includes('.test.') || fp.filePath.includes('.spec.'));

    if (testFiles.length > 0) {
      const testSuffix = testFiles[0].filePath.includes('.test.') ? '.test.' : '.spec.';
      conventions.push({
        id: 'conv-test-files',
        category: 'testing',
        rule: `Test files use ${testSuffix} suffix`,
        examples: testFiles.map(fp => fp.filePath.split('/').pop()!).slice(0, 3),
        confidence: Math.min(1, testFiles.length * 0.2),
      });
    }

    return conventions;
  }

  learnArchitectureConventions(fingerprints: FileFingerprint[]): Convention[] {
    const conventions: Convention[] = [];

    // Check for barrel exports (index.ts re-exporting modules)
    const hasBarrelExports = fingerprints.some(fp =>
      fp.filePath.endsWith('index.ts') && fp.exports.length > 2
    );
    if (hasBarrelExports) {
      conventions.push({
        id: 'conv-barrel-exports',
        category: 'architecture',
        rule: 'Modules use barrel exports (index.ts)',
        examples: ['index.ts'],
        confidence: 0.7,
      });
    }

    return conventions;
  }

  private isCamelCase(name: string): boolean {
    return /^[a-z][a-zA-Z0-9]*$/.test(name) && /[A-Z]/.test(name);
  }

  private isPascalCase(name: string): boolean {
    return /^[A-Z][a-zA-Z0-9]*$/.test(name);
  }

  private countCamelCase(names: string[]): number {
    return names.filter(n => this.isCamelCase(n)).length;
  }

  private countPascalCase(names: string[]): number {
    return names.filter(n => this.isPascalCase(n)).length;
  }
}
