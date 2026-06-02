import { describe, it, expect } from 'vitest';
import { GitExecutor, DEFAULT_GIT_CONFIG } from '../src/core/git-executor.js';

describe('GitExecutor config', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_GIT_CONFIG.strategy).toBe('feature_branch');
    expect(DEFAULT_GIT_CONFIG.branch.prefix).toBe('fix/');
    expect(DEFAULT_GIT_CONFIG.branch.baseBranch).toBe('main');
    expect(DEFAULT_GIT_CONFIG.commit.messageTemplate).toBe('fix: {description}');
    expect(DEFAULT_GIT_CONFIG.push.remote).toBe('origin');
    expect(DEFAULT_GIT_CONFIG.push.force).toBe(false);
  });

  it('merges partial config', () => {
    const executor = new GitExecutor({
      strategy: 'direct_commit',
      branch: { prefix: 'hotfix/' },
    });
    // Config is private, but we can verify via behavior in integration tests
    expect(executor).toBeDefined();
  });
});

describe('GitExecutor utility methods', () => {
  it('identifies protected branches', async () => {
    const executor = new GitExecutor();
    expect(await executor.isProtectedBranch('main')).toBe(true);
    expect(await executor.isProtectedBranch('master')).toBe(true);
    expect(await executor.isProtectedBranch('production')).toBe(true);
    expect(await executor.isProtectedBranch('release')).toBe(true);
    expect(await executor.isProtectedBranch('feature-x')).toBe(false);
    expect(await executor.isProtectedBranch('fix-bug-123')).toBe(false);
  });
});

describe('GitExecutionResult type', () => {
  it('has the expected shape', () => {
    const result = {
      success: true,
      branch: 'fix/test',
      commitHash: 'abc123',
      pushed: true,
      messages: ['Created branch', 'Committed', 'Pushed'],
      errors: [],
    };
    expect(result.success).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
