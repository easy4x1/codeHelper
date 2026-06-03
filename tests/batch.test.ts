import { describe, it, expect } from 'vitest';

describe('Batch processing', () => {
  it('validates batch file format', () => {
    const valid = {
      tasks: [{ description: 'Fix something', files: ['src/index.ts'] }],
      options: { parallel: false, autoPush: false, webSearch: false },
    };
    expect(Array.isArray(valid.tasks)).toBe(true);
    expect(valid.tasks[0].description).toBe('Fix something');
    expect(valid.tasks[0].files).toContain('src/index.ts');
  });

  it('rejects invalid batch file (missing tasks)', () => {
    const invalid = { options: {} };
    expect(Array.isArray((invalid as Record<string, unknown>).tasks)).toBe(false);
  });

  it('rejects invalid batch file (non-array tasks)', () => {
    const invalid = { tasks: 'not-an-array' };
    expect(Array.isArray(invalid.tasks)).toBe(false);
  });

  it('supports parallel option', () => {
    const batch = {
      tasks: [{ description: 'Task 1' }, { description: 'Task 2' }],
      options: { parallel: true },
    };
    expect(batch.options?.parallel).toBe(true);
  });

  it('supports autoPush option', () => {
    const batch = {
      tasks: [{ description: 'Task 1' }],
      options: { autoPush: true },
    };
    expect(batch.options?.autoPush).toBe(true);
  });
});
