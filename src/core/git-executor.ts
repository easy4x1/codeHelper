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
  prUrl?: string;
  messages: string[];
  errors: string[];
}

/** Parsed components of a git remote URL. */
export interface RemoteInfo {
  host: string;
  owner: string;
  repo: string;
}

/**
 * Parse a git remote URL (SSH or HTTPS) into host/owner/repo.
 * Returns null if the URL is not a recognized git remote.
 */
export function parseRemoteUrl(remote: string): RemoteInfo | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;

  // SSH form: git@host:owner/repo(.git)
  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { host: sshMatch[1], owner: sshMatch[2], repo: sshMatch[3] };
  }

  // HTTPS/HTTP form: https://host/owner/repo(.git)
  const httpsMatch = trimmed.match(/^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { host: httpsMatch[1], owner: httpsMatch[2], repo: httpsMatch[3] };
  }

  return null;
}

/**
 * Build a GitHub-style "compare" URL for opening a pull request manually.
 * Returns null if the remote cannot be parsed.
 */
export function buildCompareUrl(
  remote: string,
  base: string,
  head: string
): string | null {
  const info = parseRemoteUrl(remote);
  if (!info) return null;
  return `https://${info.host}/${info.owner}/${info.repo}/compare/${base}...${head}?expand=1`;
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

  /** Check whether the GitHub CLI (`gh`) is installed and on PATH. */
  async isGhAvailable(): Promise<boolean> {
    try {
      await execAsync('gh --version', { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Resolve the push remote's URL, or null if it cannot be read. */
  async getRemoteUrl(remote?: string): Promise<string | null> {
    const targetRemote = remote || this.config.push.remote;
    try {
      const { stdout } = await execAsync(`git remote get-url ${targetRemote}`);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Open a pull request for `head` against `base`.
   * Uses `gh pr create` when available; otherwise falls back to a manual
   * compare URL the user can open in a browser. Never throws — failures and
   * fallbacks are reported via the returned object.
   */
  async createPullRequest(
    title: string,
    body: string,
    head: string,
    base?: string
  ): Promise<{ created: boolean; url?: string; manual: boolean; message: string }> {
    const baseBranch = base || this.config.branch.baseBranch;

    if (await this.isGhAvailable()) {
      try {
        const cmd =
          `gh pr create --title "${title.replace(/"/g, '\\"')}"` +
          ` --body "${body.replace(/"/g, '\\"')}"` +
          ` --base ${baseBranch} --head ${head}`;
        logger.info(`Creating pull request: ${head} → ${baseBranch}`);
        const { stdout } = await execAsync(cmd);
        const url = stdout.trim().split('\n').find(l => l.startsWith('http')) || stdout.trim();
        return { created: true, url, manual: false, message: `Pull request created: ${url}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`gh pr create failed, falling back to manual URL: ${msg}`);
      }
    }

    // Fallback: build a manual compare URL from the remote.
    const remoteUrl = await this.getRemoteUrl();
    const compareUrl = remoteUrl ? buildCompareUrl(remoteUrl, baseBranch, head) : null;
    if (compareUrl) {
      return {
        created: false,
        url: compareUrl,
        manual: true,
        message: `Open a pull request manually: ${compareUrl}`,
      };
    }

    return {
      created: false,
      manual: true,
      message: 'Could not create a pull request: `gh` is unavailable and the remote URL could not be resolved.',
    };
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

        // Optionally open a pull request for the pushed branch.
        if (this.config.push.createPR && !(await this.isProtectedBranch(currentBranch))) {
          const pr = await this.createPullRequest(
            commitMessage,
            `Automated fix: ${description}`,
            currentBranch
          );
          if (pr.url) result.prUrl = pr.url;
          result.messages.push(pr.message);
        }
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
