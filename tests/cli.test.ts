import { describe, it, expect } from 'vitest';
import { CodeRepairAgent } from '../src/index.js';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'sample-repo');

describe('CodeRepairAgent', () => {
  it('initializes with config', () => {
    const agent = new CodeRepairAgent({ verbose: true });
    expect(agent).toBeDefined();
  });

  it('initializes a repo', async () => {
    const agent = new CodeRepairAgent({});
    const result = await agent.init(fixturePath);
    expect(result.files).toBeDefined();
    expect(result.files.length).toBeGreaterThan(0);
  });

  it('plans a repair task', async () => {
    const agent = new CodeRepairAgent({});
    await agent.init(fixturePath);

    const plan = await agent.plan({
      id: 'task-1',
      description: 'Fix potential issues',
      type: 'bug',
      priority: 'medium',
    });

    expect(plan.id).toBeDefined();
    expect(plan.changes).toBeDefined();
    expect(plan.problem).toBeDefined();
  });

  it('serializes memory to disk', async () => {
    const agent = new CodeRepairAgent({});
    await agent.init(fixturePath);
    await agent.saveMemory('/tmp/test-memory.json');
    // Just verify no error thrown
    expect(true).toBe(true);
  });
});
