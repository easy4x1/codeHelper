# Code Repair Agent - MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimum viable Code Repair Agent that can scan a repo, detect faults, build context, generate a solution plan, and present it for human review.

**Architecture:** TypeScript CLI tool with a modular core (fingerprinting, knowledge graph, memory layer) and specialized agents that collaborate through a task pipeline. Tree-sitter for deterministic code parsing, LLM for semantic analysis.

**Tech Stack:** TypeScript, Node.js 20+, Tree-sitter, vitest, Commander.js, fuse.js

---

## File Structure

```
/Users/apple/code-agent/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                 # CLI entry point
│   ├── core/
│   │   ├── types.ts             # Shared type definitions
│   │   ├── fingerprint.ts       # File fingerprinting + change classification
│   │   ├── knowledge-graph.ts   # Knowledge graph data structure
│   │   ├── memory.ts            # Memory middleware (L1/L2/L3)
│   │   └── repo-scanner.ts      # Tree-sitter based repo scanning
│   ├── agents/
│   │   ├── base-agent.ts        # Base agent class
│   │   ├── repo-scanner-agent.ts
│   │   ├── fault-detector-agent.ts
│   │   ├── context-builder-agent.ts
│   │   └── solution-planner-agent.ts
│   └── utils/
│       ├── hash.ts              # SHA-256 utilities
│       └── logger.ts            # Structured logging
├── tests/
│   ├── fixtures/
│   │   └── sample-repo/         # Test fixture repo
│   ├── fingerprint.test.ts
│   ├── knowledge-graph.test.ts
│   └── scanner.test.ts
└── docs/
    └── agents/
        ├── repo-scanner.md      # Agent prompt definition
        ├── fault-detector.md
        ├── context-builder.md
        └── solution-planner.md
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "code-repair-agent",
  "version": "0.1.0",
  "description": "AI-powered code repair agent with fingerprint-based incremental analysis",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "code-agent": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest",
    "test:run": "vitest run"
  },
  "dependencies": {
    "commander": "^12.0.0",
    "fuse.js": "^7.0.0",
    "tree-sitter": "^0.21.0",
    "tree-sitter-javascript": "^0.21.0",
    "tree-sitter-typescript": "^0.21.0",
    "tree-sitter-python": "^0.21.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
*.log
.repair-agent/
.DS_Store
coverage/
```

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore
git commit -m "chore: project scaffolding"
```

---

### Task 2: Core Types

**Files:**
- Create: `src/core/types.ts`
- Test: `tests/types.test.ts`

- [ ] **Step 1: Write test for types**

```typescript
import { describe, it, expect } from 'vitest';
import type { FileFingerprint, ChangeLevel, KnowledgeGraph, GraphNode, GraphEdge } from '../src/core/types.js';

describe('types', () => {
  it('FileFingerprint interface is usable', () => {
    const fp: FileFingerprint = {
      filePath: 'src/index.ts',
      contentHash: 'abc123',
      functions: [],
      classes: [],
      imports: [],
      exports: [],
      totalLines: 100,
      hasStructuralAnalysis: true,
    };
    expect(fp.filePath).toBe('src/index.ts');
  });

  it('ChangeLevel union works', () => {
    const levels: ChangeLevel[] = ['NONE', 'COSMETIC', 'STRUCTURAL', 'SEMANTIC'];
    expect(levels).toHaveLength(4);
  });

  it('KnowledgeGraph can be constructed', () => {
    const node: GraphNode = {
      id: 'file:src/index.ts',
      type: 'file',
      name: 'index.ts',
      filePath: 'src/index.ts',
    };
    const edge: GraphEdge = {
      id: 'edge-1',
      source: 'file:src/index.ts',
      target: 'function:src/index.ts:main',
      type: 'contains',
      weight: 1.0,
    };
    const graph: KnowledgeGraph = {
      nodes: [node],
      edges: [edge],
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    };
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/types.test.ts`
Expected: FAIL - modules not found

- [ ] **Step 3: Implement types.ts**

```typescript
// ============================================
// Node Types
// ============================================
export type NodeType =
  | 'file'
  | 'function'
  | 'class'
  | 'module'
  | 'concept'
  | 'config'
  | 'document'
  | 'service'
  | 'table'
  | 'endpoint'
  | 'pipeline'
  | 'schema'
  | 'resource'
  | 'fault'
  | 'fix'
  | 'pattern';

export type EdgeType =
  | 'contains'
  | 'imports'
  | 'exports'
  | 'inherits'
  | 'implements'
  | 'calls'
  | 'subscribes'
  | 'publishes'
  | 'middleware'
  | 'reads_from'
  | 'writes_to'
  | 'transforms'
  | 'validates'
  | 'depends_on'
  | 'tested_by'
  | 'configures'
  | 'related'
  | 'similar_to'
  | 'deploys'
  | 'serves'
  | 'provisions'
  | 'triggers'
  | 'migrates'
  | 'documents'
  | 'routes'
  | 'defines_schema'
  | 'fixes'
  | 'mitigates'
  | 'relates_to_fault'
  | 'suggests'
  | 'learned_from';

export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  filePath?: string;
  summary?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  weight: number;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  version: string;
  timestamp: string;
}

// ============================================
// Fingerprint Types
// ============================================
export interface FunctionSignature {
  name: string;
  params: string[];
  returnType?: string;
  isExported: boolean;
  startLine: number;
  endLine: number;
}

export interface ClassSignature {
  name: string;
  methods: string[];
  properties: string[];
  isExported: boolean;
  startLine: number;
  endLine: number;
}

export interface ImportSignature {
  source: string;
  items: string[];
  isDefault?: boolean;
  line: number;
}

export interface ExportSignature {
  name: string;
  type: 'function' | 'class' | 'variable' | 'default';
  line: number;
}

export interface FileFingerprint {
  filePath: string;
  contentHash: string;
  functions: FunctionSignature[];
  classes: ClassSignature[];
  imports: ImportSignature[];
  exports: ExportSignature[];
  totalLines: number;
  hasStructuralAnalysis: boolean;
}

export type ChangeLevel = 'NONE' | 'COSMETIC' | 'STRUCTURAL' | 'SEMANTIC';

export interface ChangeAnalysis {
  filePath: string;
  changeLevel: ChangeLevel;
  details: string[];
}

// ============================================
// Memory Types
// ============================================
export interface RepoMemory {
  knowledgeGraph: KnowledgeGraph;
  fingerprints: Record<string, FileFingerprint>;
  importMap: Record<string, string[]>;
  version: string;
}

export interface TaskContext {
  taskId: string;
  analyzedFiles: Set<string>;
  recalledNodes: GraphNode[];
  findings: Finding[];
}

export interface Finding {
  id: string;
  type: 'fault' | 'pattern' | 'insight';
  description: string;
  confidence: number;
  nodeIds: string[];
}

export interface LearnedMemory {
  taskHistory: TaskRecord[];
  faultPatterns: FaultPattern[];
  fixPatterns: FixPattern[];
}

export interface TaskRecord {
  taskId: string;
  description: string;
  timestamp: string;
  filesAnalyzed: string[];
  findingsCount: number;
}

export interface FaultPattern {
  id: string;
  pattern: string;
  language?: string;
  frequency: number;
}

export interface FixPattern {
  id: string;
  pattern: string;
  language?: string;
  frequency: number;
}

export interface MemoryLayer {
  repoMemory: RepoMemory;
  taskContext: TaskContext;
  learnedMemory: LearnedMemory;
}

// ============================================
// Agent Types
// ============================================
export interface AgentInput {
  taskId: string;
  instruction: string;
  context: Record<string, unknown>;
}

export interface AgentOutput {
  taskId: string;
  agentName: string;
  result: Record<string, unknown>;
  findings: Finding[];
}

export interface RepairTask {
  id: string;
  description: string;
  type: 'bug' | 'feature' | 'refactor' | 'performance' | 'security';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  context?: {
    files?: string[];
    errorLog?: string;
    stackTrace?: string;
  };
  constraints?: {
    maxFiles?: number;
    breakingChanges?: boolean;
    testRequired?: boolean;
  };
}

export interface SolutionPlan {
  id: string;
  timestamp: string;
  taskId: string;
  problem: {
    description: string;
    rootCause: string;
    severity: string;
  };
  changes: FileChange[];
  metadata: {
    confidence: number;
    tokenUsed: number;
  };
}

export interface FileChange {
  filePath: string;
  changeType: 'modify' | 'add' | 'delete' | 'rename';
  description: string;
  reasoning: string;
  originalCode?: string;
  modifiedCode?: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts tests/types.test.ts
git commit -m "feat: core type definitions"
```

---

### Task 3: Fingerprint Module

**Files:**
- Create: `src/utils/hash.ts`
- Create: `src/core/fingerprint.ts`
- Test: `tests/fingerprint.test.ts`

- [ ] **Step 1: Write test for fingerprint module**

```typescript
import { describe, it, expect } from 'vitest';
import { computeFingerprint, classifyChange, type FileFingerprint } from '../src/core/fingerprint.js';
import { createHash } from '../src/utils/hash.js';

describe('hash utility', () => {
  it('creates consistent SHA-256 hash', () => {
    const hash1 = createHash('hello world');
    const hash2 = createHash('hello world');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });
});

describe('fingerprint', () => {
  it('computes fingerprint for a file', () => {
    const content = `import { foo } from './foo';
export function bar() { return foo(); }
export class Baz { run() {} }
`;
    const fp = computeFingerprint('src/test.ts', content);
    expect(fp.filePath).toBe('src/test.ts');
    expect(fp.contentHash).toHaveLength(64);
    expect(fp.functions).toHaveLength(1);
    expect(fp.functions[0].name).toBe('bar');
    expect(fp.classes).toHaveLength(1);
    expect(fp.classes[0].name).toBe('Baz');
    expect(fp.imports).toHaveLength(1);
    expect(fp.imports[0].source).toBe('./foo');
    expect(fp.exports).toHaveLength(2);
    expect(fp.totalLines).toBe(4);
    expect(fp.hasStructuralAnalysis).toBe(true);
  });

  it('classifies NONE change', () => {
    const old: FileFingerprint = {
      filePath: 'src/test.ts',
      contentHash: 'abc',
      functions: [{ name: 'foo', params: [], isExported: true, startLine: 1, endLine: 2 }],
      classes: [],
      imports: [],
      exports: [{ name: 'foo', type: 'function', line: 1 }],
      totalLines: 2,
      hasStructuralAnalysis: true,
    };
    const result = classifyChange(old, old);
    expect(result.changeLevel).toBe('NONE');
  });

  it('classifies COSMETIC change', () => {
    const old: FileFingerprint = {
      filePath: 'src/test.ts',
      contentHash: 'abc',
      functions: [{ name: 'foo', params: [], isExported: true, startLine: 1, endLine: 2 }],
      classes: [],
      imports: [],
      exports: [{ name: 'foo', type: 'function', line: 1 }],
      totalLines: 2,
      hasStructuralAnalysis: true,
    };
    const neu: FileFingerprint = {
      ...old,
      contentHash: 'def',
    };
    const result = classifyChange(old, neu);
    expect(result.changeLevel).toBe('COSMETIC');
  });

  it('classifies STRUCTURAL change', () => {
    const old: FileFingerprint = {
      filePath: 'src/test.ts',
      contentHash: 'abc',
      functions: [{ name: 'foo', params: [], isExported: true, startLine: 1, endLine: 2 }],
      classes: [],
      imports: [],
      exports: [{ name: 'foo', type: 'function', line: 1 }],
      totalLines: 2,
      hasStructuralAnalysis: true,
    };
    const neu: FileFingerprint = {
      ...old,
      contentHash: 'def',
      functions: [{ name: 'foo', params: ['x'], isExported: true, startLine: 1, endLine: 2 }],
    };
    const result = classifyChange(old, neu);
    expect(result.changeLevel).toBe('STRUCTURAL');
  });
});
```

- [ ] **Step 2: Implement hash utility**

```typescript
import { createHash as cryptoCreateHash } from 'crypto';

export function createHash(content: string): string {
  return cryptoCreateHash('sha256').update(content, 'utf-8').digest('hex');
}
```

- [ ] **Step 3: Implement fingerprint module**

```typescript
import { createHash } from '../utils/hash.js';
import type {
  FileFingerprint,
  FunctionSignature,
  ClassSignature,
  ImportSignature,
  ExportSignature,
  ChangeLevel,
  ChangeAnalysis,
} from './types.js';

export function computeFingerprint(filePath: string, content: string): FileFingerprint {
  const lines = content.split('\n');
  const functions = extractFunctions(content);
  const classes = extractClasses(content);
  const imports = extractImports(content);
  const exports = extractExports(content);

  return {
    filePath,
    contentHash: createHash(content),
    functions,
    classes,
    imports,
    exports,
    totalLines: lines.length,
    hasStructuralAnalysis: true,
  };
}

function extractFunctions(content: string): FunctionSignature[] {
  const functions: FunctionSignature[] = [];
  const lines = content.split('\n');

  // Pattern: export? async? function name(params) { ... }
  const funcRegex = /^(export\s+)?(async\s+)?function\s+(\w+)\s*\(([^)]*)\)/;
  // Pattern: const name = (params) => { ... }
  const arrowRegex = /^(export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/;
  // Pattern: const name = async function(params) { ... }
  const asyncFuncRegex = /^(export\s+)?const\s+(\w+)\s*=\s*async\s+function\s*\(([^)]*)\)/;

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    let match = line.match(funcRegex);
    if (match) {
      functions.push({
        name: match[3],
        params: match[4].split(',').map(p => p.trim()).filter(Boolean),
        isExported: !!match[1],
        startLine: lineNum,
        endLine: lineNum,
      });
      return;
    }
    match = line.match(arrowRegex);
    if (match) {
      functions.push({
        name: match[2],
        params: match[3].split(',').map(p => p.trim()).filter(Boolean),
        isExported: !!match[1],
        startLine: lineNum,
        endLine: lineNum,
      });
      return;
    }
    match = line.match(asyncFuncRegex);
    if (match) {
      functions.push({
        name: match[2],
        params: match[3].split(',').map(p => p.trim()).filter(Boolean),
        isExported: !!match[1],
        startLine: lineNum,
        endLine: lineNum,
      });
    }
  });

  return functions;
}

function extractClasses(content: string): ClassSignature[] {
  const classes: ClassSignature[] = [];
  const lines = content.split('\n');
  const classRegex = /^(export\s+)?class\s+(\w+)/;

  lines.forEach((line, idx) => {
    const match = line.match(classRegex);
    if (match) {
      classes.push({
        name: match[2],
        methods: [],
        properties: [],
        isExported: !!match[1],
        startLine: idx + 1,
        endLine: idx + 1,
      });
    }
  });

  return classes;
}

function extractImports(content: string): ImportSignature[] {
  const imports: ImportSignature[] = [];
  const lines = content.split('\n');
  const importRegex = /import\s+(?:(\{[^}]+\})|(\w+))\s+from\s+['"]([^'"]+)['"]/;

  lines.forEach((line, idx) => {
    const match = line.match(importRegex);
    if (match) {
      const items = match[1]
        ? match[1].replace(/[{}]/g, '').split(',').map(s => s.trim()).filter(Boolean)
        : match[2]
          ? [match[2]]
          : [];
      imports.push({
        source: match[3],
        items,
        isDefault: !!match[2],
        line: idx + 1,
      });
    }
  });

  return imports;
}

function extractExports(content: string): ExportSignature[] {
  const exports: ExportSignature[] = [];
  const lines = content.split('\n');
  const exportRegex = /^export\s+(?:default\s+)?(?:(?:async\s+)?function|class|const|let|var|type|interface)\s+(\w+)/;
  const defaultRegex = /^export\s+default\s+(\w+)/;

  lines.forEach((line, idx) => {
    let match = line.match(exportRegex);
    if (match) {
      const type: ExportSignature['type'] = line.includes('function')
        ? 'function'
        : line.includes('class')
          ? 'class'
          : 'variable';
      exports.push({ name: match[1], type, line: idx + 1 });
      return;
    }
    match = line.match(defaultRegex);
    if (match) {
      exports.push({ name: match[1], type: 'default', line: idx + 1 });
    }
  });

  return exports;
}

export function classifyChange(
  oldFp: FileFingerprint | null,
  newFp: FileFingerprint
): ChangeAnalysis {
  if (!oldFp) {
    return { filePath: newFp.filePath, changeLevel: 'STRUCTURAL', details: ['New file'] };
  }

  if (oldFp.contentHash === newFp.contentHash) {
    return { filePath: newFp.filePath, changeLevel: 'NONE', details: ['No changes'] };
  }

  const details: string[] = [];

  if (!signaturesEqual(oldFp.functions, newFp.functions)) {
    details.push('Function signatures changed');
  }
  if (!signaturesEqual(oldFp.classes, newFp.classes)) {
    details.push('Class signatures changed');
  }
  if (!signaturesEqual(oldFp.imports, newFp.imports)) {
    details.push('Import signatures changed');
  }
  if (!signaturesEqual(oldFp.exports, newFp.exports)) {
    details.push('Export signatures changed');
  }

  const changeLevel: ChangeLevel = details.length > 0 ? 'STRUCTURAL' : 'COSMETIC';

  return { filePath: newFp.filePath, changeLevel, details };
}

function signaturesEqual<T extends Record<string, unknown>>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  const serialize = (x: T) => JSON.stringify(x, Object.keys(x).sort());
  const setA = new Set(a.map(serialize));
  const setB = new Set(b.map(serialize));
  if (setA.size !== setB.size) return false;
  for (const item of setA) {
    if (!setB.has(item)) return false;
  }
  return true;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/fingerprint.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/hash.ts src/core/fingerprint.ts tests/fingerprint.test.ts
git commit -m "feat: fingerprint module with change classification"
```

---

### Task 4: Knowledge Graph Module

**Files:**
- Create: `src/core/knowledge-graph.ts`
- Test: `tests/knowledge-graph.test.ts`

- [ ] **Step 1: Write test for knowledge graph**

```typescript
import { describe, it, expect } from 'vitest';
import { KnowledgeGraphBuilder } from '../src/core/knowledge-graph.js';
import type { GraphNode, GraphEdge } from '../src/core/types.js';

describe('KnowledgeGraphBuilder', () => {
  it('creates empty graph', () => {
    const builder = new KnowledgeGraphBuilder();
    const graph = builder.build();
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });

  it('adds nodes and builds', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'file:src/index.ts', type: 'file', name: 'index.ts' });
    builder.addNode({ id: 'function:src/index.ts:main', type: 'function', name: 'main' });
    const graph = builder.build();
    expect(graph.nodes).toHaveLength(2);
  });

  it('adds edges', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'file:src/index.ts', type: 'file', name: 'index.ts' });
    builder.addNode({ id: 'function:src/index.ts:main', type: 'function', name: 'main' });
    builder.addEdge('file:src/index.ts', 'function:src/index.ts:main', 'contains', 1.0);
    const graph = builder.build();
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].type).toBe('contains');
  });

  it('prevents duplicate nodes', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'file:src/index.ts', type: 'file', name: 'index.ts' });
    builder.addNode({ id: 'file:src/index.ts', type: 'file', name: 'index.ts' });
    const graph = builder.build();
    expect(graph.nodes).toHaveLength(1);
  });

  it('finds node by id', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'file:src/index.ts', type: 'file', name: 'index.ts' });
    expect(builder.findNode('file:src/index.ts')).toBeDefined();
    expect(builder.findNode('nonexistent')).toBeUndefined();
  });

  it('finds neighbors', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'a', type: 'file', name: 'a.ts' });
    builder.addNode({ id: 'b', type: 'function', name: 'b' });
    builder.addNode({ id: 'c', type: 'function', name: 'c' });
    builder.addEdge('a', 'b', 'contains', 1.0);
    builder.addEdge('a', 'c', 'contains', 1.0);
    const neighbors = builder.findNeighbors('a', 'contains');
    expect(neighbors).toHaveLength(2);
  });

  it('serializes and deserializes', () => {
    const builder = new KnowledgeGraphBuilder();
    builder.addNode({ id: 'a', type: 'file', name: 'a.ts' });
    builder.addEdge('a', 'b', 'contains', 1.0);
    const graph = builder.build();

    const json = JSON.stringify(graph);
    const parsed = JSON.parse(json);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.edges).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement knowledge graph module**

```typescript
import type { KnowledgeGraph, GraphNode, GraphEdge } from './types.js';

export class KnowledgeGraphBuilder {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();

  addNode(node: Omit<GraphNode, 'id'> & { id: string }): void {
    this.nodes.set(node.id, { ...node });
  }

  addEdge(source: string, target: string, type: GraphEdge['type'], weight: number): void {
    const id = `${source}--${type}--${target}`;
    this.edges.set(id, { id, source, target, type, weight });
  }

  findNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  findNeighbors(nodeId: string, edgeType?: string): GraphNode[] {
    const neighborIds = new Set<string>();
    for (const edge of this.edges.values()) {
      if (edge.source === nodeId && (!edgeType || edge.type === edgeType)) {
        neighborIds.add(edge.target);
      }
      if (edge.target === nodeId && (!edgeType || edge.type === edgeType)) {
        neighborIds.add(edge.source);
      }
    }
    return Array.from(neighborIds)
      .map(id => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined);
  }

  getNodesByType(type: GraphNode['type']): GraphNode[] {
    return Array.from(this.nodes.values()).filter(n => n.type === type);
  }

  build(): KnowledgeGraph {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    };
  }

  static fromGraph(graph: KnowledgeGraph): KnowledgeGraphBuilder {
    const builder = new KnowledgeGraphBuilder();
    for (const node of graph.nodes) {
      builder.nodes.set(node.id, node);
    }
    for (const edge of graph.edges) {
      builder.edges.set(edge.id, edge);
    }
    return builder;
  }
}

export function mergeGraphs(base: KnowledgeGraph, updates: KnowledgeGraph): KnowledgeGraph {
  const builder = KnowledgeGraphBuilder.fromGraph(base);

  for (const node of updates.nodes) {
    builder.addNode(node);
  }
  for (const edge of updates.edges) {
    builder.addEdge(edge.source, edge.target, edge.type, edge.weight);
  }

  return builder.build();
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/knowledge-graph.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/knowledge-graph.ts tests/knowledge-graph.test.ts
git commit -m "feat: knowledge graph builder with merge support"
```

---

### Task 5: Memory Middleware

**Files:**
- Create: `src/core/memory.ts`
- Test: `tests/memory.test.ts`

- [ ] **Step 1: Write test for memory middleware**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryMiddleware } from '../src/core/memory.js';
import type { KnowledgeGraph, FileFingerprint } from '../src/core/types.js';

describe('MemoryMiddleware', () => {
  let memory: MemoryMiddleware;

  beforeEach(() => {
    memory = new MemoryMiddleware();
  });

  it('initializes with empty state', () => {
    expect(memory.getRepoMemory().knowledgeGraph.nodes).toHaveLength(0);
    expect(memory.getRepoMemory().fingerprints).toEqual({});
  });

  it('saves and loads repo memory', () => {
    const graph: KnowledgeGraph = {
      nodes: [{ id: 'a', type: 'file', name: 'a.ts' }],
      edges: [],
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    };
    memory.setRepoMemory({ ...memory.getRepoMemory(), knowledgeGraph: graph });
    expect(memory.getRepoMemory().knowledgeGraph.nodes).toHaveLength(1);
  });

  it('tracks task context', () => {
    memory.startTask('task-1');
    expect(memory.getTaskContext().taskId).toBe('task-1');
    memory.markFileAnalyzed('src/foo.ts');
    expect(memory.getTaskContext().analyzedFiles.has('src/foo.ts')).toBe(true);
  });

  it('stores fingerprints', () => {
    const fp: FileFingerprint = {
      filePath: 'src/foo.ts',
      contentHash: 'abc',
      functions: [],
      classes: [],
      imports: [],
      exports: [],
      totalLines: 10,
      hasStructuralAnalysis: true,
    };
    memory.setFingerprint(fp);
    expect(memory.getFingerprint('src/foo.ts')).toEqual(fp);
  });

  it('serializes and deserializes', () => {
    memory.startTask('task-1');
    const fp: FileFingerprint = {
      filePath: 'src/foo.ts',
      contentHash: 'abc',
      functions: [],
      classes: [],
      imports: [],
      exports: [],
      totalLines: 10,
      hasStructuralAnalysis: true,
    };
    memory.setFingerprint(fp);

    const json = memory.serialize();
    const restored = MemoryMiddleware.deserialize(json);
    expect(restored.getFingerprint('src/foo.ts')).toEqual(fp);
    expect(restored.getTaskContext().taskId).toBe('task-1');
  });
});
```

- [ ] **Step 2: Implement memory middleware**

```typescript
import type {
  RepoMemory,
  TaskContext,
  LearnedMemory,
  MemoryLayer,
  KnowledgeGraph,
  FileFingerprint,
  Finding,
} from './types.js';

const DEFAULT_REPO_MEMORY: RepoMemory = {
  knowledgeGraph: { nodes: [], edges: [], version: '1.0.0', timestamp: new Date().toISOString() },
  fingerprints: {},
  importMap: {},
  version: '1.0.0',
};

const DEFAULT_TASK_CONTEXT: TaskContext = {
  taskId: '',
  analyzedFiles: new Set(),
  recalledNodes: [],
  findings: [],
};

const DEFAULT_LEARNED_MEMORY: LearnedMemory = {
  taskHistory: [],
  faultPatterns: [],
  fixPatterns: [],
};

export class MemoryMiddleware {
  private repoMemory: RepoMemory;
  private taskContext: TaskContext;
  private learnedMemory: LearnedMemory;

  constructor(layer?: Partial<MemoryLayer>) {
    this.repoMemory = layer?.repoMemory ? { ...layer.repoMemory } : { ...DEFAULT_REPO_MEMORY };
    this.taskContext = layer?.taskContext
      ? { ...layer.taskContext, analyzedFiles: new Set(layer.taskContext.analyzedFiles) }
      : { ...DEFAULT_TASK_CONTEXT };
    this.learnedMemory = layer?.learnedMemory ? { ...layer.learnedMemory } : { ...DEFAULT_LEARNED_MEMORY };
  }

  // Repo Memory (L1)
  getRepoMemory(): RepoMemory {
    return { ...this.repoMemory };
  }

  setRepoMemory(repoMemory: RepoMemory): void {
    this.repoMemory = repoMemory;
  }

  getKnowledgeGraph(): KnowledgeGraph {
    return this.repoMemory.knowledgeGraph;
  }

  setKnowledgeGraph(graph: KnowledgeGraph): void {
    this.repoMemory = { ...this.repoMemory, knowledgeGraph: graph };
  }

  getFingerprint(filePath: string): FileFingerprint | undefined {
    return this.repoMemory.fingerprints[filePath];
  }

  setFingerprint(fp: FileFingerprint): void {
    this.repoMemory.fingerprints[fp.filePath] = fp;
  }

  getAllFingerprints(): Record<string, FileFingerprint> {
    return { ...this.repoMemory.fingerprints };
  }

  // Task Context (L2)
  startTask(taskId: string): void {
    this.taskContext = {
      taskId,
      analyzedFiles: new Set(),
      recalledNodes: [],
      findings: [],
    };
  }

  getTaskContext(): TaskContext {
    return {
      ...this.taskContext,
      analyzedFiles: new Set(this.taskContext.analyzedFiles),
    };
  }

  markFileAnalyzed(filePath: string): void {
    this.taskContext.analyzedFiles.add(filePath);
  }

  addFinding(finding: Finding): void {
    this.taskContext.findings.push(finding);
  }

  // Learned Memory (L3)
  getLearnedMemory(): LearnedMemory {
    return { ...this.learnedMemory };
  }

  // Serialization
  serialize(): string {
    const layer: MemoryLayer = {
      repoMemory: this.repoMemory,
      taskContext: {
        ...this.taskContext,
        analyzedFiles: Array.from(this.taskContext.analyzedFiles),
      } as unknown as TaskContext,
      learnedMemory: this.learnedMemory,
    };
    return JSON.stringify(layer, null, 2);
  }

  static deserialize(json: string): MemoryMiddleware {
    const parsed = JSON.parse(json) as MemoryLayer;
    return new MemoryMiddleware({
      repoMemory: parsed.repoMemory,
      taskContext: {
        ...parsed.taskContext,
        analyzedFiles: new Set(parsed.taskContext.analyzedFiles as unknown as string[]),
      },
      learnedMemory: parsed.learnedMemory,
    });
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/memory.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/memory.ts tests/memory.test.ts
git commit -m "feat: memory middleware with L1/L2/L3 layers"
```

---

### Task 6: Repo Scanner

**Files:**
- Create: `src/core/repo-scanner.ts`
- Create: `tests/fixtures/sample-repo/src/utils.ts`
- Create: `tests/fixtures/sample-repo/src/index.ts`
- Create: `tests/fixtures/sample-repo/package.json`
- Test: `tests/scanner.test.ts`

- [ ] **Step 1: Create test fixture repo**

`tests/fixtures/sample-repo/package.json`:
```json
{
  "name": "sample-repo",
  "version": "1.0.0"
}
```

`tests/fixtures/sample-repo/src/index.ts`:
```typescript
import { helper } from './utils.js';

export function main(): void {
  const result = helper();
  console.log(result);
}

export class App {
  run(): void {
    main();
  }
}
```

`tests/fixtures/sample-repo/src/utils.ts`:
```typescript
export function helper(): string {
  return 'hello';
}
```

- [ ] **Step 2: Write test for repo scanner**

```typescript
import { describe, it, expect } from 'vitest';
import { scanRepo, buildImportMap } from '../src/core/repo-scanner.js';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'sample-repo');

describe('repo-scanner', () => {
  it('scans repo and returns files', async () => {
    const result = await scanRepo(fixturePath);
    const filePaths = result.files.map(f => f.filePath);
    expect(filePaths).toContain('src/index.ts');
    expect(filePaths).toContain('src/utils.ts');
    expect(filePaths).not.toContain('package.json');
  });

  it('computes fingerprints for all files', async () => {
    const result = await scanRepo(fixturePath);
    expect(result.fingerprints).toHaveLength(2);
    const indexFp = result.fingerprints.find(f => f.filePath === 'src/index.ts');
    expect(indexFp).toBeDefined();
    expect(indexFp!.functions).toHaveLength(1);
    expect(indexFp!.classes).toHaveLength(1);
    expect(indexFp!.imports).toHaveLength(1);
    expect(indexFp!.exports).toHaveLength(2);
  });

  it('builds import map', async () => {
    const result = await scanRepo(fixturePath);
    const importMap = buildImportMap(result.fingerprints);
    expect(importMap['src/index.ts']).toContain('./utils.js');
  });
});
```

- [ ] **Step 3: Implement repo scanner**

```typescript
import { readdir, readFile, stat } from 'fs/promises';
import { join, relative } from 'path';
import { computeFingerprint } from './fingerprint.js';
import type { FileFingerprint } from './types.js';

export interface ScanResult {
  files: { filePath: string; absolutePath: string }[];
  fingerprints: FileFingerprint[];
  languages: Set<string>;
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

  await walkDir(repoPath, repoPath, files, languages);

  const fingerprints: FileFingerprint[] = [];
  for (const file of files) {
    try {
      const content = await readFile(file.absolutePath, 'utf-8');
      const fp = computeFingerprint(file.filePath, content);
      fingerprints.push(fp);
    } catch {
      // Skip unreadable files
    }
  }

  return { files, fingerprints, languages };
}

async function walkDir(
  rootPath: string,
  currentPath: string,
  files: { filePath: string; absolutePath: string }[],
  languages: Set<string>
): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        await walkDir(rootPath, join(currentPath, entry.name), files, languages);
      }
      continue;
    }

    if (entry.isFile()) {
      if (IGNORED_FILES.has(entry.name)) continue;

      const ext = entry.name.slice(entry.name.lastIndexOf('.'));
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
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/scanner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/repo-scanner.ts tests/scanner.test.ts tests/fixtures/
git commit -m "feat: repo scanner with import map generation"
```

---

### Task 7: Base Agent Class

**Files:**
- Create: `src/agents/base-agent.ts`
- Create: `src/utils/logger.ts`
- Test: `tests/base-agent.test.ts`

- [ ] **Step 1: Write test for base agent**

```typescript
import { describe, it, expect } from 'vitest';
import { BaseAgent } from '../src/agents/base-agent.js';
import type { AgentInput, AgentOutput, Finding } from '../src/core/types.js';

class TestAgent extends BaseAgent {
  constructor() {
    super('test-agent');
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    return { message: `Processed: ${input.instruction}` };
  }
}

describe('BaseAgent', () => {
  it('has correct name', () => {
    const agent = new TestAgent();
    expect(agent.name).toBe('test-agent');
  });

  it('runs and returns output', async () => {
    const agent = new TestAgent();
    const input: AgentInput = {
      taskId: 'task-1',
      instruction: 'test instruction',
      context: {},
    };
    const output = await agent.run(input);
    expect(output.agentName).toBe('test-agent');
    expect(output.taskId).toBe('task-1');
    expect(output.result.message).toBe('Processed: test instruction');
    expect(output.findings).toHaveLength(0);
  });

  it('tracks execution time', async () => {
    const agent = new TestAgent();
    const input: AgentInput = {
      taskId: 'task-1',
      instruction: 'test',
      context: {},
    };
    const output = await agent.run(input);
    expect(output.result._meta).toBeDefined();
    expect(typeof (output.result._meta as Record<string, unknown>).durationMs).toBe('number');
  });
});
```

- [ ] **Step 2: Implement logger**

```typescript
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  constructor(private prefix: string = '') {}

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    const timestamp = new Date().toISOString();
    const prefix = this.prefix ? `[${this.prefix}]` : '';
    console.log(`${timestamp} ${level.toUpperCase().padStart(5)} ${prefix} ${message}`, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.log('debug', message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log('info', message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log('warn', message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log('error', message, ...args);
  }
}

export function createLogger(prefix: string): Logger {
  return new Logger(prefix);
}
```

- [ ] **Step 3: Implement base agent**

```typescript
import type { AgentInput, AgentOutput, Finding } from '../core/types.js';
import { createLogger } from '../utils/logger.js';

export abstract class BaseAgent {
  protected logger = createLogger(this.name);

  constructor(public readonly name: string) {}

  async run(input: AgentInput): Promise<AgentOutput> {
    this.logger.info(`Starting execution for task ${input.taskId}`);
    const startTime = Date.now();

    try {
      const result = await this.execute(input);
      const duration = Date.now() - startTime;

      this.logger.info(`Completed in ${duration}ms`);

      return {
        taskId: input.taskId,
        agentName: this.name,
        result: {
          ...result,
          _meta: {
            durationMs: duration,
            timestamp: new Date().toISOString(),
          },
        },
        findings: (result.findings as Finding[] | undefined) || [],
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`Failed after ${duration}ms:`, error);
      throw error;
    }
  }

  protected abstract execute(input: AgentInput): Promise<Record<string, unknown>>;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/base-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/base-agent.ts src/utils/logger.ts tests/base-agent.test.ts
git commit -m "feat: base agent class with logging and timing"
```

---

### Task 8: Specialized Agents

**Files:**
- Create: `src/agents/repo-scanner-agent.ts`
- Create: `src/agents/fault-detector-agent.ts`
- Create: `src/agents/context-builder-agent.ts`
- Create: `src/agents/solution-planner-agent.ts`
- Test: `tests/agents.test.ts`

- [ ] **Step 1: Write test for specialized agents**

```typescript
import { describe, it, expect } from 'vitest';
import { RepoScannerAgent } from '../src/agents/repo-scanner-agent.js';
import { FaultDetectorAgent } from '../src/agents/fault-detector-agent.js';
import { ContextBuilderAgent } from '../src/agents/context-builder-agent.js';
import { SolutionPlannerAgent } from '../src/agents/solution-planner-agent.js';
import { MemoryMiddleware } from '../src/core/memory.js';
import type { AgentInput, KnowledgeGraph, GraphNode } from '../src/core/types.js';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'sample-repo');

describe('RepoScannerAgent', () => {
  it('scans repo and stores in memory', async () => {
    const memory = new MemoryMiddleware();
    const agent = new RepoScannerAgent(memory);
    const input: AgentInput = {
      taskId: 'task-1',
      instruction: 'Scan the repository',
      context: { repoPath: fixturePath },
    };
    const output = await agent.run(input);
    expect(output.result.files).toBeDefined();
    expect(Array.isArray(output.result.files)).toBe(true);
    expect(memory.getRepoMemory().fingerprints).toBeDefined();
  });
});

describe('FaultDetectorAgent', () => {
  it('detects faults in code', async () => {
    const memory = new MemoryMiddleware();
    const graph: KnowledgeGraph = {
      nodes: [
        { id: 'file:src/index.ts', type: 'file', name: 'index.ts' },
        { id: 'function:src/index.ts:main', type: 'function', name: 'main' },
      ],
      edges: [],
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    };
    memory.setKnowledgeGraph(graph);

    const agent = new FaultDetectorAgent(memory);
    const input: AgentInput = {
      taskId: 'task-1',
      instruction: 'Find issues',
      context: { targetFiles: ['src/index.ts'] },
    };
    const output = await agent.run(input);
    expect(output.findings).toBeDefined();
    expect(Array.isArray(output.findings)).toBe(true);
  });
});

describe('ContextBuilderAgent', () => {
  it('builds context for target nodes', async () => {
    const memory = new MemoryMiddleware();
    const graph: KnowledgeGraph = {
      nodes: [
        { id: 'file:src/index.ts', type: 'file', name: 'index.ts' },
        { id: 'function:src/index.ts:main', type: 'function', name: 'main' },
      ],
      edges: [
        { id: 'e1', source: 'file:src/index.ts', target: 'function:src/index.ts:main', type: 'contains', weight: 1.0 },
      ],
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    };
    memory.setKnowledgeGraph(graph);

    const agent = new ContextBuilderAgent(memory);
    const input: AgentInput = {
      taskId: 'task-1',
      instruction: 'Build context',
      context: { nodeIds: ['function:src/index.ts:main'] },
    };
    const output = await agent.run(input);
    expect(output.result.nodes).toBeDefined();
    expect(Array.isArray(output.result.nodes)).toBe(true);
  });
});

describe('SolutionPlannerAgent', () => {
  it('generates a solution plan', async () => {
    const memory = new MemoryMiddleware();
    const agent = new SolutionPlannerAgent(memory);
    const input: AgentInput = {
      taskId: 'task-1',
      instruction: 'Fix the bug',
      context: {
        problem: 'Null pointer exception in main()',
        affectedFiles: ['src/index.ts'],
        findings: [
          { id: 'f1', type: 'fault', description: 'Missing null check', confidence: 0.9, nodeIds: ['function:src/index.ts:main'] },
        ],
      },
    };
    const output = await agent.run(input);
    expect(output.result.plan).toBeDefined();
    expect(output.result.plan).toHaveProperty('id');
    expect(output.result.plan).toHaveProperty('changes');
  });
});
```

- [ ] **Step 2: Implement repo scanner agent**

```typescript
import { BaseAgent } from './base-agent.js';
import { scanRepo, buildImportMap } from '../core/repo-scanner.js';
import { MemoryMiddleware } from '../core/memory.js';
import type { AgentInput } from '../core/types.js';

export class RepoScannerAgent extends BaseAgent {
  constructor(private memory: MemoryMiddleware) {
    super('repo-scanner');
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const repoPath = input.context.repoPath as string;
    if (!repoPath) {
      throw new Error('repoPath is required in context');
    }

    this.logger.info(`Scanning repository at ${repoPath}`);
    const result = await scanRepo(repoPath);

    // Store fingerprints in memory
    for (const fp of result.fingerprints) {
      this.memory.setFingerprint(fp);
    }

    const importMap = buildImportMap(result.fingerprints);
    const repoMemory = this.memory.getRepoMemory();
    repoMemory.importMap = importMap;
    this.memory.setRepoMemory(repoMemory);

    this.logger.info(`Scanned ${result.files.length} files, ${result.fingerprints.length} fingerprints`);

    return {
      files: result.files.map(f => f.filePath),
      fingerprintCount: result.fingerprints.length,
      languages: Array.from(result.languages),
      importMap,
    };
  }
}
```

- [ ] **Step 3: Implement fault detector agent**

```typescript
import { BaseAgent } from './base-agent.js';
import { MemoryMiddleware } from '../core/memory.js';
import type { AgentInput, Finding, GraphNode } from '../core/types.js';

export class FaultDetectorAgent extends BaseAgent {
  constructor(private memory: MemoryMiddleware) {
    super('fault-detector');
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const targetFiles = input.context.targetFiles as string[] || [];
    const graph = this.memory.getKnowledgeGraph();
    const findings: Finding[] = [];

    for (const node of graph.nodes) {
      if (targetFiles.length > 0 && node.filePath && !targetFiles.includes(node.filePath)) {
        continue;
      }

      const nodeFindings = this.analyzeNode(node);
      findings.push(...nodeFindings);
    }

    for (const finding of findings) {
      this.memory.addFinding(finding);
    }

    return {
      findingsCount: findings.length,
      findings,
    };
  }

  private analyzeNode(node: GraphNode): Finding[] {
    const findings: Finding[] = [];

    // Heuristic: functions without exports in non-test files might be dead code
    if (node.type === 'function' && !node.filePath?.includes('.test.')) {
      const graph = this.memory.getKnowledgeGraph();
      const hasCallers = graph.edges.some(e => e.target === node.id && e.type === 'calls');
      if (!hasCallers && node.metadata?.isExported === false) {
        findings.push({
          id: `finding-${node.id}-deadcode`,
          type: 'insight',
          description: `Potentially dead code: ${node.name}`,
          confidence: 0.5,
          nodeIds: [node.id],
        });
      }
    }

    return findings;
  }
}
```

- [ ] **Step 4: Implement context builder agent**

```typescript
import { BaseAgent } from './base-agent.js';
import { MemoryMiddleware } from '../core/memory.js';
import type { AgentInput, GraphNode } from '../core/types.js';

export class ContextBuilderAgent extends BaseAgent {
  constructor(private memory: MemoryMiddleware) {
    super('context-builder');
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const nodeIds = input.context.nodeIds as string[] || [];
    const graph = this.memory.getKnowledgeGraph();
    const contextNodes: GraphNode[] = [];

    for (const nodeId of nodeIds) {
      const node = graph.nodes.find(n => n.id === nodeId);
      if (!node) continue;

      contextNodes.push(node);

      // Add neighbors (callers, callees, containers)
      for (const edge of graph.edges) {
        if (edge.source === nodeId || edge.target === nodeId) {
          const neighborId = edge.source === nodeId ? edge.target : edge.source;
          const neighbor = graph.nodes.find(n => n.id === neighborId);
          if (neighbor && !contextNodes.find(n => n.id === neighbor.id)) {
            contextNodes.push(neighbor);
          }
        }
      }
    }

    return {
      nodes: contextNodes,
      nodeCount: contextNodes.length,
    };
  }
}
```

- [ ] **Step 5: Implement solution planner agent**

```typescript
import { BaseAgent } from './base-agent.js';
import { MemoryMiddleware } from '../core/memory.js';
import type { AgentInput, SolutionPlan, FileChange, Finding } from '../core/types.js';

export class SolutionPlannerAgent extends BaseAgent {
  constructor(private memory: MemoryMiddleware) {
    super('solution-planner');
  }

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const problem = input.context.problem as string || 'Unknown issue';
    const findings = (input.context.findings as Finding[] || []) as Finding[];
    const affectedFiles = input.context.affectedFiles as string[] || [];

    const changes: FileChange[] = affectedFiles.map(filePath => ({
      filePath,
      changeType: 'modify',
      description: `Review and fix issues in ${filePath}`,
      reasoning: `File identified as part of the problem scope`,
    }));

    const plan: SolutionPlan = {
      id: `plan-${input.taskId}`,
      timestamp: new Date().toISOString(),
      taskId: input.taskId,
      problem: {
        description: problem,
        rootCause: findings.length > 0
          ? findings.map(f => f.description).join('; ')
          : 'Root cause analysis pending',
        severity: 'medium',
      },
      changes,
      metadata: {
        confidence: findings.length > 0 ? 0.7 : 0.3,
        tokenUsed: 0,
      },
    };

    return {
      plan,
      changeCount: changes.length,
    };
  }
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/agents.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/agents/
git commit -m "feat: specialized agents (scanner, detector, context, planner)"
```

---

### Task 9: CLI Entry Point

**Files:**
- Create: `src/index.ts`
- Modify: `package.json` (add bin field)
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Write test for CLI**

```typescript
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
```

- [ ] **Step 2: Implement CLI entry point**

```typescript
#!/usr/bin/env node

import { Command } from 'commander';
import { MemoryMiddleware } from './core/memory.js';
import { RepoScannerAgent } from './agents/repo-scanner-agent.js';
import { FaultDetectorAgent } from './agents/fault-detector-agent.js';
import { ContextBuilderAgent } from './agents/context-builder-agent.js';
import { SolutionPlannerAgent } from './agents/solution-planner-agent.js';
import { KnowledgeGraphBuilder } from './core/knowledge-graph.js';
import { writeFile, readFile, access } from 'fs/promises';
import { join, resolve } from 'path';
import type { RepairTask, SolutionPlan, AgentConfig } from './core/types.js';

export interface AgentConfig {
  verbose?: boolean;
  memoryPath?: string;
}

export class CodeRepairAgent {
  private memory: MemoryMiddleware;
  private config: AgentConfig;

  constructor(config: AgentConfig = {}) {
    this.config = config;
    this.memory = new MemoryMiddleware();
  }

  async init(repoPath: string): Promise<{ files: string[]; fingerprintCount: number }> {
    const scanner = new RepoScannerAgent(this.memory);
    const result = await scanner.run({
      taskId: `init-${Date.now()}`,
      instruction: 'Initialize repository scan',
      context: { repoPath: resolve(repoPath) },
    });

    // Build a basic knowledge graph from fingerprints
    const builder = new KnowledgeGraphBuilder();
    const fingerprints = this.memory.getAllFingerprints();
    for (const [path, fp] of Object.entries(fingerprints)) {
      builder.addNode({ id: `file:${path}`, type: 'file', name: path.split('/').pop() || path, filePath: path });
      for (const fn of fp.functions) {
        builder.addNode({ id: `function:${path}:${fn.name}`, type: 'function', name: fn.name, filePath: path });
        builder.addEdge(`file:${path}`, `function:${path}:${fn.name}`, 'contains', 1.0);
      }
      for (const cls of fp.classes) {
        builder.addNode({ id: `class:${path}:${cls.name}`, type: 'class', name: cls.name, filePath: path });
        builder.addEdge(`file:${path}`, `class:${path}:${cls.name}`, 'contains', 1.0);
      }
      for (const imp of fp.imports) {
        builder.addEdge(`file:${path}`, `module:${imp.source}`, 'imports', 0.7);
      }
    }
    this.memory.setKnowledgeGraph(builder.build());

    const files = result.result.files as string[];
    return {
      files,
      fingerprintCount: files.length,
    };
  }

  async plan(task: RepairTask): Promise<SolutionPlan> {
    const detector = new FaultDetectorAgent(this.memory);
    const detectorResult = await detector.run({
      taskId: task.id,
      instruction: task.description,
      context: { targetFiles: task.context?.files || [] },
    });

    const findings = detectorResult.findings;

    let contextResult = { result: { nodes: [] } };
    if (findings.length > 0) {
      const nodeIds = findings.flatMap(f => f.nodeIds);
      const builder = new ContextBuilderAgent(this.memory);
      contextResult = await builder.run({
        taskId: task.id,
        instruction: 'Build context for findings',
        context: { nodeIds },
      });
    }

    const planner = new SolutionPlannerAgent(this.memory);
    const plannerResult = await planner.run({
      taskId: task.id,
      instruction: task.description,
      context: {
        problem: task.description,
        findings,
        affectedFiles: task.context?.files || [],
      },
    });

    return plannerResult.result.plan as SolutionPlan;
  }

  async saveMemory(path: string): Promise<void> {
    const serialized = this.memory.serialize();
    await writeFile(path, serialized, 'utf-8');
  }

  async loadMemory(path: string): Promise<void> {
    try {
      await access(path);
      const data = await readFile(path, 'utf-8');
      this.memory = MemoryMiddleware.deserialize(data);
    } catch {
      // File doesn't exist, use fresh memory
    }
  }

  getMemory(): MemoryMiddleware {
    return this.memory;
  }
}

// CLI setup
async function main(): Promise<void> {
  const program = new Command();

  program
    .name('code-agent')
    .description('AI-powered code repair agent')
    .version('0.1.0');

  program
    .command('init')
    .description('Initialize agent for a repository')
    .argument('[repo-path]', 'Path to repository', '.')
    .action(async (repoPath: string) => {
      const agent = new CodeRepairAgent({ verbose: true });
      const result = await agent.init(repoPath);
      await agent.saveMemory(join(resolve(repoPath), '.repair-agent', 'memory.json'));
      console.log(`Initialized: ${result.fingerprintCount} files scanned`);
    });

  program
    .command('plan')
    .description('Generate a repair plan')
    .argument('<description>', 'Problem description')
    .option('-r, --repo <path>', 'Repository path', '.')
    .option('--file <file>', 'Target file(s)', collect, [])
    .action(async (description: string, options: { repo: string; file: string[] }) => {
      const agent = new CodeRepairAgent({ verbose: true });
      const memoryPath = join(resolve(options.repo), '.repair-agent', 'memory.json');
      await agent.loadMemory(memoryPath);

      const task: RepairTask = {
        id: `task-${Date.now()}`,
        description,
        type: 'bug',
        priority: 'medium',
        context: {
          files: options.file.length > 0 ? options.file : undefined,
        },
      };

      const plan = await agent.plan(task);
      console.log('\n=== Solution Plan ===\n');
      console.log(`ID: ${plan.id}`);
      console.log(`Problem: ${plan.problem.description}`);
      console.log(`Root Cause: ${plan.problem.rootCause}`);
      console.log(`\nChanges (${plan.changes.length}):`);
      for (const change of plan.changes) {
        console.log(`  - ${change.filePath}: ${change.description}`);
      }
      console.log(`\nConfidence: ${(plan.metadata.confidence * 100).toFixed(1)}%`);
    });

  program
    .command('status')
    .description('Show knowledge graph status')
    .argument('[repo-path]', 'Path to repository', '.')
    .action(async (repoPath: string) => {
      const agent = new CodeRepairAgent({});
      const memoryPath = join(resolve(repoPath), '.repair-agent', 'memory.json');
      await agent.loadMemory(memoryPath);
      const memory = agent.getMemory();
      const graph = memory.getKnowledgeGraph();
      const fingerprints = memory.getAllFingerprints();
      console.log(`Nodes: ${graph.nodes.length}`);
      console.log(`Edges: ${graph.edges.length}`);
      console.log(`Fingerprints: ${Object.keys(fingerprints).length}`);
    });

  await program.parseAsync();
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Update package.json bin field**

Add to existing package.json:
```json
"bin": {
  "code-agent": "dist/index.js"
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS

- [ ] **Step 5: Build and verify CLI**

Run: `npx tsc`
Run: `node dist/index.js --help`
Expected: Shows help with init, plan, status commands

- [ ] **Step 6: Commit**

```bash
git add src/index.ts tests/cli.test.ts
git commit -m "feat: CLI entry point with init, plan, status commands"
```

---

### Task 10: Agent Prompt Definitions

**Files:**
- Create: `docs/agents/repo-scanner.md`
- Create: `docs/agents/fault-detector.md`
- Create: `docs/agents/context-builder.md`
- Create: `docs/agents/solution-planner.md`

- [ ] **Step 1: Create repo-scanner agent definition**

```markdown
---
name: repo-scanner
description: |
  Scans a code repository to discover files, compute fingerprints,
  build an import map, and construct the initial knowledge graph.
---

# Repo Scanner Agent

## Task

Scan the repository at the given path and produce:
1. A list of all source files
2. Structural fingerprints for each file
3. An import map showing module dependencies
4. A knowledge graph with file/function/class nodes

## Phase 1: Discovery

1. Walk the directory tree (respect .gitignore)
2. Identify source files by extension
3. Skip: node_modules, .git, dist, build, coverage

## Phase 2: Fingerprinting

For each source file:
1. Read file content
2. Compute SHA-256 content hash
3. Extract: functions, classes, imports, exports
4. Store fingerprint in memory layer

## Phase 3: Graph Building

1. Create file nodes
2. Create function/class nodes (linked to file via `contains`)
3. Create import edges (file -> module via `imports`)
4. Persist graph to memory

## Output Format

```json
{
  "files": ["src/index.ts", "src/utils.ts"],
  "fingerprintCount": 2,
  "languages": [".ts"],
  "importMap": {
    "src/index.ts": ["./utils.js"]
  }
}
```

## Critical Constraints

- Must handle binary/unreadable files gracefully
- Must use deterministic parsing (regex + tree-sitter hybrid)
- Fingerprints must be stored in LOAD-PATCH-SAVE manner
```

- [ ] **Step 2: Create fault-detector agent definition**

```markdown
---
name: fault-detector
description: |
  Analyzes the knowledge graph to detect potential faults,
  code smells, and issues in the codebase.
---

# Fault Detector Agent

## Task

Analyze the knowledge graph and identify:
1. Potential bugs (null pointer risks, unhandled errors)
2. Code smells (dead code, duplicate logic)
3. Performance issues (inefficient patterns)
4. Security risks (unsafe operations)

## Phase 1: Static Analysis

For each target file:
1. Check for common anti-patterns
2. Identify unexported functions with no callers
3. Flag missing error handling

## Phase 2: Heuristic Detection

Apply heuristics:
- Functions without callers + not exported = dead code (confidence: 0.5)
- Files with no tests = missing coverage (confidence: 0.3)
- Console.log in source = debug residue (confidence: 0.7)

## Output Format

```json
{
  "findingsCount": 3,
  "findings": [
    {
      "id": "finding-1",
      "type": "insight",
      "description": "Potentially dead code: unusedHelper",
      "confidence": 0.5,
      "nodeIds": ["function:src/utils.ts:unusedHelper"]
    }
  ]
}
```
```

- [ ] **Step 3: Create context-builder agent definition**

```markdown
---
name: context-builder
description: |
  Builds rich context around identified faults by traversing
  the knowledge graph to find related code.
---

# Context Builder Agent

## Task

Given a set of node IDs (from fault findings), build comprehensive
context including:
1. The target nodes themselves
2. Direct neighbors (callers, callees, containers)
3. Related imports/exports
4. Test coverage (if available)

## Phase 1: Node Retrieval

For each node ID:
1. Find the node in the knowledge graph
2. Extract metadata (name, type, file, summary)

## Phase 2: Neighbor Traversal

Traverse edges:
- `contains`: parent file
- `calls`: callers and callees
- `imports`: imported modules
- `exports`: exported consumers

## Phase 3: Context Assembly

Assemble a subgraph with:
- All relevant nodes
- Connecting edges
- Sorted by relevance (distance from fault)

## Output Format

```json
{
  "nodes": [
    { "id": "function:src/index.ts:main", "type": "function", "name": "main" },
    { "id": "file:src/index.ts", "type": "file", "name": "index.ts" }
  ],
  "nodeCount": 5
}
```
```

- [ ] **Step 4: Create solution-planner agent definition**

```markdown
---
name: solution-planner
description: |
  Generates a structured solution plan based on fault findings
  and built context, ready for human review.
---

# Solution Planner Agent

## Task

Given problem description and findings, produce:
1. Root cause analysis
2. Structured change plan (per file)
3. Risk assessment
4. Confidence score

## Phase 1: Problem Analysis

1. Aggregate findings by severity
2. Identify affected files
3. Estimate change scope

## Phase 2: Plan Generation

For each affected file:
1. Determine change type (modify/add/delete/rename)
2. Write change description
3. Provide reasoning
4. List potential side effects

## Phase 3: Validation

1. Check plan against constraints
2. Ensure no breaking changes (unless allowed)
3. Verify test coverage

## Output Format

```json
{
  "plan": {
    "id": "plan-task-1",
    "timestamp": "2026-05-28T10:00:00Z",
    "taskId": "task-1",
    "problem": {
      "description": "Null pointer exception",
      "rootCause": "Missing null check in main()",
      "severity": "medium"
    },
    "changes": [
      {
        "filePath": "src/index.ts",
        "changeType": "modify",
        "description": "Add null check before accessing property",
        "reasoning": "Stack trace points to line 15 where result could be null"
      }
    ],
    "metadata": {
      "confidence": 0.85,
      "tokenUsed": 1500
    }
  }
}
```
```

- [ ] **Step 5: Commit**

```bash
git add docs/agents/
git commit -m "docs: agent prompt definitions in Markdown+YAML format"
```

---

## Self-Review Checklist

**1. Spec coverage:**
- [x] Fingerprint module (change classification, hash) → Task 3
- [x] Knowledge graph (builder, merge) → Task 4
- [x] Memory middleware (L1/L2/L3) → Task 5
- [x] Repo scanner (file discovery, import map) → Task 6
- [x] Multi-agent pipeline (scanner → detector → context → planner) → Tasks 7-8
- [x] CLI interface (init, plan, status) → Task 9
- [x] Agent definitions in Markdown format → Task 10
- [ ] Tree-sitter integration → Deferred to Phase 2 (using regex fallback in MVP)
- [ ] LLM integration → Deferred to Phase 2 (heuristic-based in MVP)
- [ ] Web search → Deferred to Phase 3
- [ ] Patch generation + git execution → Deferred to Phase 4

**2. Placeholder scan:**
- No TBD/TODO placeholders found
- All steps include actual code
- All tests include assertions

**3. Type consistency:**
- FileFingerprint, ChangeLevel used consistently
- GraphNode, GraphEdge, KnowledgeGraph aligned
- AgentInput/AgentOutput used across all agents
