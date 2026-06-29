import { describe, it, expect } from 'vitest';
import {
  TemplateLlmService,
  AnthropicLlmService,
  repairTruncatedJson,
} from '../src/core/llm-service.js';
import { parseContext, repoScannerContextSchema, faultDetectorContextSchema } from '../src/core/types.js';

describe('TemplateLlmService', () => {
  const service = new TemplateLlmService();

  describe('analyzeFault', () => {
    it('detects null dereference pattern', async () => {
      const result = await service.analyzeFault({
        filePath: 'src/test.ts',
        code: `function process(data) {
  return data.map(x => x * 2);
}`,
        nodeType: 'function',
        nodeName: 'process',
        relatedCode: [],
      });

      const nullFinding = result.findings.find(f => f.description.includes('null'));
      expect(nullFinding).toBeDefined();
      expect(nullFinding!.type).toBe('bug');
      expect(nullFinding!.confidence).toBeGreaterThan(0);
    });

    it('detects TODO comments', async () => {
      const result = await service.analyzeFault({
        filePath: 'src/test.ts',
        code: `function main() {
  // TODO: implement this
  return 0;
}`,
        nodeType: 'function',
        nodeName: 'main',
        relatedCode: [],
      });

      const todoFinding = result.findings.find(f => f.description.includes('TODO'));
      expect(todoFinding).toBeDefined();
      expect(todoFinding!.type).toBe('bug');
    });

    it('detects empty catch blocks', async () => {
      const result = await service.analyzeFault({
        filePath: 'src/test.ts',
        code: `try {
  riskyOp();
} catch (e) {}`,
        nodeType: 'function',
        nodeName: 'test',
        relatedCode: [],
      });

      const catchFinding = result.findings.find(f => f.description.includes('catch'));
      expect(catchFinding).toBeDefined();
      expect(catchFinding!.confidence).toBeGreaterThan(0.8);
    });

    it('detects unused variables', async () => {
      const result = await service.analyzeFault({
        filePath: 'src/test.ts',
        code: `function main() {
  const unused = 42;
  return 0;
}`,
        nodeType: 'function',
        nodeName: 'main',
        relatedCode: [],
      });

      const unusedFinding = result.findings.find(f => f.description.includes('Unused'));
      expect(unusedFinding).toBeDefined();
    });

    it('returns empty findings for clean code', async () => {
      const result = await service.analyzeFault({
        filePath: 'src/test.ts',
        code: `export function add(a: number, b: number): number {
  return a + b;
}`,
        nodeType: 'function',
        nodeName: 'add',
        relatedCode: [],
      });

      expect(result.findings.length).toBe(0);
      expect(result.rootCause).toBeUndefined();
    });
  });

  describe('generateSolution', () => {
    it('generates null-safety fix', async () => {
      const result = await service.generateSolution({
        problem: 'Null pointer exception',
        findings: [
          { description: 'Potential null dereference: data may be null', confidence: 0.8, type: 'bug' },
        ],
        codeContext: [
          { filePath: 'src/test.ts', code: `function process(data) {\n  return data.map(x => x * 2);\n}` },
        ],
      });

      expect(result.changes.length).toBeGreaterThan(0);
      expect(result.severity).toBe('high');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('generates severity based on finding types', async () => {
      const criticalResult = await service.generateSolution({
        problem: 'Security issue',
        findings: [
          { description: 'SQL injection risk', confidence: 0.9, type: 'security' },
        ],
        codeContext: [{ filePath: 'src/db.ts', code: 'export function query(sql) { return db.exec(sql); }' }],
      });

      expect(criticalResult.severity).toBe('critical');

      const styleResult = await service.generateSolution({
        problem: 'Code style',
        findings: [
          { description: 'Console logging detected', confidence: 0.5, type: 'style' },
        ],
        codeContext: [{ filePath: 'src/app.ts', code: 'console.log("hello");' }],
      });

      expect(styleResult.severity).toBe('medium');
    });
  });
});

describe('AnthropicLlmService', () => {
  it('falls back to TemplateLlmService when API key is missing', async () => {
    const service = new AnthropicLlmService();

    const result = await service.analyzeFault({
      filePath: 'src/test.ts',
      code: `function process(data) {\n  return data.map(x => x * 2);\n}`,
      nodeType: 'function',
      nodeName: 'process',
      relatedCode: [],
    });

    // Should return findings from template fallback (null dereference detected)
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.some(f => f.description.includes('null'))).toBe(true);
  });

  it('falls back for generateSolution when API key is missing', async () => {
    const service = new AnthropicLlmService();

    const result = await service.generateSolution({
      problem: 'Null pointer exception',
      findings: [
        { description: 'Potential null dereference', confidence: 0.8, type: 'bug' },
      ],
      codeContext: [
        { filePath: 'src/test.ts', code: 'function process(data) { return data.map(x => x * 2); }' },
      ],
    });

    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThan(0);
  });
});

describe('Agent Context Validation', () => {
  it('validates repo scanner context', () => {
    const valid = parseContext({ repoPath: '/tmp/repo' }, repoScannerContextSchema);
    expect(valid.repoPath).toBe('/tmp/repo');
  });

  it('rejects invalid repo scanner context', () => {
    expect(() => parseContext({}, repoScannerContextSchema)).toThrow('repoPath');
  });

  it('validates fault detector context with defaults', () => {
    const valid = parseContext({}, faultDetectorContextSchema);
    expect(valid.targetFiles).toEqual([]);
    expect(valid.repoPath).toBe('.');
  });
});

describe('repairTruncatedJson', () => {
  it('closes an unclosed string and object', () => {
    const truncated = '{"edges":[{"source":"a","target":"b","type":"validates","confidence":0.9';
    const repaired = repairTruncatedJson(truncated);
    expect(JSON.parse(repaired)).toEqual({
      edges: [{ source: 'a', target: 'b', type: 'validates', confidence: 0.9 }],
    });
  });

  it('closes nested arrays and objects', () => {
    const truncated = '{"edges":[{"source":"a","target":"b","type":"validates","confidence":0.9},{"source":"c","target":"d","type":"transforms"';
    const repaired = repairTruncatedJson(truncated);
    const parsed = JSON.parse(repaired) as { edges: unknown[] };
    expect(parsed.edges[0]).toEqual({
      source: 'a',
      target: 'b',
      type: 'validates',
      confidence: 0.9,
    });
    expect(parsed.edges.length).toBeGreaterThanOrEqual(1);
  });

  it('returns valid JSON unchanged', () => {
    const valid = '{"edges":[]}';
    expect(repairTruncatedJson(valid)).toBe(valid);
  });
});
