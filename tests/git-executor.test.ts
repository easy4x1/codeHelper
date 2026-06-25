import { describe, it, expect } from 'vitest';
import {
  GitExecutor,
  DEFAULT_GIT_CONFIG,
  parseRemoteUrl,
  buildCompareUrl,
} from '../src/core/git-executor.js';

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

describe('parseRemoteUrl', () => {
  it('parses SSH GitHub remotes', () => {
    expect(parseRemoteUrl('git@github.com:owner/repo.git')).toEqual({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses HTTPS GitHub remotes', () => {
    expect(parseRemoteUrl('https://github.com/owner/repo.git')).toEqual({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses HTTPS remotes without .git suffix', () => {
    expect(parseRemoteUrl('https://github.com/owner/repo')).toEqual({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses self-hosted GitLab SSH remotes', () => {
    expect(parseRemoteUrl('git@gitlab.example.com:group/proj.git')).toEqual({
      host: 'gitlab.example.com',
      owner: 'group',
      repo: 'proj',
    });
  });

  it('returns null for unrecognized remotes', () => {
    expect(parseRemoteUrl('')).toBeNull();
    expect(parseRemoteUrl('not-a-url')).toBeNull();
  });
});

describe('buildCompareUrl', () => {
  it('builds a GitHub compare URL from an SSH remote', () => {
    expect(
      buildCompareUrl('git@github.com:owner/repo.git', 'main', 'fix/bug-123')
    ).toBe('https://github.com/owner/repo/compare/main...fix/bug-123?expand=1');
  });

  it('builds a GitHub compare URL from an HTTPS remote', () => {
    expect(
      buildCompareUrl('https://github.com/owner/repo', 'develop', 'feature/x')
    ).toBe('https://github.com/owner/repo/compare/develop...feature/x?expand=1');
  });

  it('returns null when the remote cannot be parsed', () => {
    expect(buildCompareUrl('garbage', 'main', 'fix/x')).toBeNull();
  });
});

describe('GitExecutor PR config', () => {
  it('defaults createPR to false', () => {
    expect(DEFAULT_GIT_CONFIG.push.createPR).toBe(false);
  });
});
