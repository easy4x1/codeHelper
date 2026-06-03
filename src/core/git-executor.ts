import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../utils/logger.js';

const execAsync = promisify(exec);
const logger = createLogger('git-executor');

export interface GitExecutionConfig {
  strategy: 'direct_commit' | 'feature_branch' | 'pull_request';
  branch: {
    prefix: string;
    naming: 'auto' | 'manual';
    baseBranch: string;
  };
  commit: {
    messageTemplate: string;
    signOff: boolean;
    gpgSign: boolean;
  };
  push: {
    remote: string;
    force: boolean;
    createPR: boolean;
  };
  /** Pre-commit safety checks (DESIGN.md 8.3 SafetyNet) */
  safetyChecks: {
    syntaxCheck: boolean;
    testRun: boolean;
    lintCheck: boolean;
    diffSizeLimit: number;    // Max lines per commit
    fileCountLimit: number;   // Max files per commit
  };
}

export const DEFAULT_GIT_CONFIG: GitExecutionConfig = {
  strategy: 'feature_branch',
  branch: {
    prefix: 'fix/',
    naming: 'auto',
    baseBranch: 'main',
  },
  commit: {
    messageTemplate: 'fix: {description}',
    signOff: false,
    gpgSign: false,
  },
  push: {
    remote: 'origin',
    force: false,
    createPR: false,
  },
  safetyChecks: {
    syntaxCheck: true,
    testRun: true,
    lintCheck: false,
    diffSizeLimit: 500,
    fileCountLimit: 20,
  },
};

export interface GitStatus {
  isRepo: boolean;
  currentBranch: string;
  hasChanges: boolean;
  untrackedFiles: string[];
  modifiedFiles: string[];
}

export interface GitExecutionResult {
  success: boolean;
  branch?: string;
  commitHash?: string;
  pushed: boolean;
  messages: string[];
  errors: string[];
}

/**
 * Safe git command executor with validation and logging.
 * All operations target the current working directory.
 */
export class GitExecutor {
  private config: GitExecutionConfig;

  constructor(config?: Partial<GitExecutionConfig>) {
    this.config = {
      ...DEFAULT_GIT_CONFIG,
      ...config,
      branch: { ...DEFAULT_GIT_CONFIG.branch, ...config?.branch },
      commit: { ...DEFAULT_GIT_CONFIG.commit, ...config?.commit },
      push: { ...DEFAULT_GIT_CONFIG.push, ...config?.push },
      safetyChecks: { ...DEFAULT_GIT_CONFIG.safetyChecks, ...config?.safetyChecks },
    };
  }

  async getStatus(): Promise<GitStatus> {
    try {
      const { stdout: branchOut } = await execAsync('git branch --show-current');
      const currentBranch = branchOut.trim();

      const { stdout: statusOut } = await execAsync('git status --porcelain');
      const lines = statusOut.trim().split('\n').filter(Boolean);

      const untrackedFiles: string[] = [];
      const modifiedFiles: string[] = [];

      for (const line of lines) {
        const status = line.slice(0, 2);
        const file = line.slice(3);
        if (status.includes('?')) {
          untrackedFiles.push(file);
        } else {
          modifiedFiles.push(file);
        }
      }

      return {
        isRepo: true,
        currentBranch,
        hasChanges: lines.length > 0,
        untrackedFiles,
        modifiedFiles,
      };
    } catch {
      return { isRepo: false, currentBranch: '', hasChanges: false, untrackedFiles: [], modifiedFiles: [] };
    }
  }

  async isProtectedBranch(branch: string): Promise<boolean> {
    const protectedBranches = ['main', 'master', 'production', 'release'];
    return protectedBranches.includes(branch);
  }

  async createBranch(branchName: string, baseBranch?: string): Promise<void> {
    const base = baseBranch || this.config.branch.baseBranch;
    logger.info(`Creating branch ${branchName} from ${base}`);
    await execAsync(`git checkout -b ${branchName} ${base}`);
  }

  async stageFiles(files: string[]): Promise<void> {
    if (files.length === 0) return;
    logger.info(`Staging ${files.length} file(s)`);
    const escaped = files.map(f => `"${f.replace(/"/g, '\\"')}"`).join(' ');
    await execAsync(`git add ${escaped}`);
  }

  async commit(message: string): Promise<string> {
    const signOff = this.config.commit.signOff ? ' --signoff' : '';
    const gpgSign = this.config.commit.gpgSign ? ' --gpg-sign' : '';
    const cmd = `git commit -m "${message.replace(/"/g, '\\"')}"${signOff}${gpgSign}`;

    logger.info(`Committing: ${message}`);
    const { stdout } = await execAsync(cmd);

    // Extract commit hash from output
    const hashMatch = stdout.match(/\[.+\s([a-f0-9]+)\]/);
    return hashMatch ? hashMatch[1] : '';
  }

  async push(branch?: string, remote?: string): Promise<void> {
    const targetBranch = branch || (await this.getStatus()).currentBranch;
    const targetRemote = remote || this.config.push.remote;
    const forceFlag = this.config.push.force ? ' --force' : '';

    logger.info(`Pushing ${targetBranch} to ${targetRemote}`);
    await execAsync(`git push ${targetRemote} ${targetBranch}${forceFlag}`);
  }

  async getDiff(): Promise<string> {
    try {
      const { stdout } = await execAsync('git diff --cached --stat');
      return stdout.trim();
    } catch {
      return '';
    }
  }

  /**
   * Run pre-commit safety checks (DESIGN.md 8.3 SafetyNet).
   * Returns array of error messages; empty array = all checks passed.
   */
  async runSafetyChecks(files: string[]): Promise<string[]> {
    const errors: string[] = [];
    const checks = this.config.safetyChecks;

    // File count limit
    if (checks.fileCountLimit > 0 && files.length > checks.fileCountLimit) {
      errors.push(
        `File count limit exceeded: ${files.length} > ${checks.fileCountLimit}`
      );
    }

    // Diff size limit
    if (checks.diffSizeLimit > 0) {
      const diff = await this.getDiff();
      const lineCount = diff.split('\n').length;
      if (lineCount > checks.diffSizeLimit) {
        errors.push(
          `Diff size limit exceeded: ${lineCount} lines > ${checks.diffSizeLimit}`
        );
      }
    }

    // Syntax check (TypeScript compilation)
    if (checks.syntaxCheck) {
      try {
        await execAsync('npx tsc --noEmit', { timeout: 30000 });
      } catch {
        errors.push('TypeScript syntax check failed');
      }
    }

    // Test run
    if (checks.testRun) {
      try {
        await execAsync('npx vitest run', { timeout: 60000 });
      } catch {
        errors.push('Test suite failed');
      }
    }

    return errors;
  }

  /**
   * Full execution flow: safety checks → stage → commit → (branch) → push
   */
  async execute(
    files: string[],
    description: string
  ): Promise<GitExecutionResult> {
    const result: GitExecutionResult = {
      success: false,
      pushed: false,
      messages: [],
      errors: [],
    };

    try {
      const status = await this.getStatus();
      if (!status.isRepo) {
        result.errors.push('Not a git repository');
        return result;
      }

      // Safety: refuse to commit directly to protected branches
      if (this.config.strategy !== 'direct_commit') {
        if (await this.isProtectedBranch(status.currentBranch)) {
          const branchName = this.generateBranchName(description);
          await this.createBranch(branchName);
          result.branch = branchName;
          result.messages.push(`Created branch: ${branchName}`);
        }
      }

      // DESIGN.md 8.3: Pre-commit safety checks
      const checkErrors = await this.runSafetyChecks(files);
      if (checkErrors.length > 0) {
        result.errors.push(...checkErrors);
        result.errors.push('Safety checks failed — commit aborted');
        return result;
      }
      result.messages.push('Safety checks passed');

      // Stage files
      await this.stageFiles(files);
      result.messages.push(`Staged ${files.length} file(s)`);

      // Commit
      const commitMessage = this.config.commit.messageTemplate.replace('{description}', description);
      const hash = await this.commit(commitMessage);
      result.commitHash = hash;
      result.messages.push(`Committed: ${commitMessage}`);

      // Push
      if (this.config.strategy !== 'direct_commit' || this.config.push.force) {
        const currentBranch = (await this.getStatus()).currentBranch;
        await this.push(currentBranch);
        result.pushed = true;
        result.messages.push(`Pushed to ${this.config.push.remote}/${currentBranch}`);
      }

      result.success = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(msg);
      logger.error('Git execution failed:', err);
    }

    return result;
  }

  private generateBranchName(description: string): string {
    const prefix = this.config.branch.prefix;
    const slug = description
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 50);
    const timestamp = Date.now().toString(36);
    return `${prefix}${slug || 'auto'}-${timestamp}`;
  }
}
