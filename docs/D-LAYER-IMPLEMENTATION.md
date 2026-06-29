# D 层 LLM 语义增强 — 执行文档

> 状态：已完成  
> 决策确认：
> 1. **纳入 `semanticEdgeEnricher`**（`transforms` / `validates` 边）
> 2. **D 层默认关闭**，仅当显式传入 `--semantic` 时启用
> 3. **架构分层节点化**：生成 `concept:layer:*` 节点，并与文件/符号节点建立 `related` 边

---

## 1. 目标

在 A/B/C 层已有图谱结构之上，引入 LLM 语义层（D 层），产出以下图谱元素：

| 产出 | 类型 | 说明 |
|------|------|------|
| 节点 `summary` / `tags` | 属性更新 | 让 function / class / file 节点具备人类可读的摘要和标签 |
| `concept:cluster:<hash>` 命名 | 节点更新 | 把 C 层匿名簇重命名为有意义的 concept 名称 |
| `concept:layer:*` 节点 + `related` 边 | 新增 | 按 API / Service / Data / UI / Utility 分层 |
| `transforms` / `validates` 边 | 新增 | 识别函数间的转换/校验语义关系 |

---

## 2. 设计原则

1. **默认关闭**：D 层消耗真实 LLM token，必须显式 `--semantic` 开启。
2. **模板可测，真 API 可用**：Template provider 给出占位输出保证测试通过；Anthropic/Http provider 给真实 prompt。
3. **不阻塞构建**：缺少 API key 时自动 fallback 到 template，但会 warn。
4. **结果可缓存**：所有 LLM 语义结果按 content/node hash 持久化到 `memory.json`，跨 `sync` 复用。
5. **DoD 含人工 review**：模板测试全绿 ≠ 功能可用，必须用真实 key 跑一次 `scripts/eval-d-layer.mjs` 并人工判断输出。

---

## 3. 改动清单

### 3.1 `src/core/types.ts`

新增 D 层 LLM 结果类型和缓存类型：

```typescript
export interface NodeSummaryResult {
  summary: string;
  tags: string[];
}

export interface ConceptNameResult {
  name: string;
  rationale: string;
}

export interface ArchitectureLayerResult {
  layer: 'api' | 'service' | 'data' | 'ui' | 'utility' | 'unknown';
  confidence: number;
}

export interface SemanticEdgeCandidate {
  source: string;
  target: string;
  type: 'transforms' | 'validates';
  confidence: number;
}

export interface SemanticEdgesResult {
  edges: SemanticEdgeCandidate[];
}

export interface LlmSemanticCacheEntry {
  key: string;
  result: unknown;
  timestamp: string;
}
```

`MemoryLayer` 增加字段：

```typescript
llmSemanticCache?: LlmSemanticCacheEntry[];
```

---

### 3.2 `src/core/llm-service.ts`

#### 扩展 `LlmService` 接口

在现有 4 个方法后追加：

```typescript
export interface LlmService {
  analyzeFault(...): Promise<FaultAnalysisResult>;
  analyzeRootCause(...): Promise<RootCauseAnalysisResult>;
  generateSolution(...): Promise<SolutionResult>;
  generatePatch(...): Promise<PatchLlmResult>;

  // D-layer
  summarizeNode(params: {
    nodeType: 'function' | 'class' | 'file';
    name: string;
    signature: string;
    codeSnippet: string;
  }): Promise<NodeSummaryResult>;

  nameConceptCluster(params: {
    members: Array<{ id: string; name: string; summary?: string }>;
  }): Promise<ConceptNameResult>;

  classifyArchitectureLayer(params: {
    nodeType: string;
    name: string;
    signature: string;
    neighbors: string[];
  }): Promise<ArchitectureLayerResult>;

  detectSemanticEdges(params: {
    functions: Array<{ id: string; name: string; signature: string; body: string }>;
  }): Promise<SemanticEdgesResult>;
}
```

#### `TemplateLlmService` 实现

给出**确定性、可测试**的占位输出：

- `summarizeNode`：基于 `name` 和 `nodeType` 生成固定句式摘要；tags 从名称关键词推断（如包含 `auth` → `['auth']`）。
- `nameConceptCluster`：取成员名称的公共 token，否则返回 `cluster-${members.length}`。
- `classifyArchitectureLayer`：基于文件路径关键词（`api`/`service`/`db`/`ui`）推断；无关键词则 `unknown`。
- `detectSemanticEdges`：基于函数名关键词（`validate`/`parse`/`transform`/`format`）产出确定性边。

#### `AnthropicLlmService` / `HttpLlmService` 实现

每个方法都走：`if (!client) fallback` → `prompt` → `messages.create` → `extractJson` → 返回类型化结果。失败时 fallback 到 `TemplateLlmService`。

Prompt 统一要求 **纯 JSON 输出，无 markdown**。

---

### 3.3 `src/core/knowledge-graph.ts`

新增 `updateNode`：

```typescript
updateNode(id: string, updates: Partial<Omit<GraphNode, 'id'>>): boolean {
  const node = this.nodes.get(id);
  if (!node) return false;
  Object.assign(node, updates);
  return true;
}
```

---

### 3.4 `src/core/memory.ts`

新增：

```typescript
private llmSemanticCache: LlmSemanticCacheEntry[] = [];

getLlmSemanticCache(): LlmSemanticCacheEntry[] { ... }
setLlmSemanticCache(entries: LlmSemanticCacheEntry[]): void { ... }
```

并在 `serialize()` / `deserialize()` 中持久化。

---

### 3.5 `src/core/llm-semantic-cache.ts`（新增）

轻量级缓存类，复用 `ResultCache` / `SemanticCache` 模式：

```typescript
export class LlmSemanticCache {
  constructor(private entries: LlmSemanticCacheEntry[] = []) {}
  get<T>(key: string): T | undefined { ... }
  set<T>(key: string, result: T): void { ... }
  export(): LlmSemanticCacheEntry[] { ... }
}
```

---

### 3.6 `src/core/graph-enrich.ts`

#### 扩展 `EnrichContext`

```typescript
export interface EnrichContext {
  enabledLayers: EnrichLayer[];
  assetFiles?: string[];
  sources?: Record<string, string>;
  llm?: LlmService;              // 从 unknown 改为 LlmService
  embeddings?: EmbeddingService;
  llmCache?: LlmSemanticCache;   // 新增
}
```

#### 新增 D 层 enrichers

##### `summaryEnricher`

遍历 `function` / `class` / `file` 节点，调用 `llm.summarizeNode`，更新 `summary` 和 `tags`。

缓存 key：`summary:<nodeId>:<fileContentHash>`

##### `conceptNamingEnricher`

找出 `type === 'concept'` 且 `id.startsWith('concept:cluster:')` 的节点，获取其 `related` 邻居成员，调用 `llm.nameConceptCluster`，重命名节点。

缓存 key：`concept-name:<clusterId>`

##### `architectureLayerEnricher`

对每个 `file` 节点，调用 `llm.classifyArchitectureLayer`，若返回非 `unknown`：

- 创建/复用 `concept:layer:<layer>` 节点
- 添加 `related` 边：文件 → layer
- 给文件节点 tag 追加 `layer:<layer>`

缓存 key：`layer:<fileNodeId>:<fileContentHash>`

##### `semanticEdgeEnricher`

按文件分批处理 `function` 节点：

1. 构造函数签名列表 + 函数体片段
2. 调用 `llm.detectSemanticEdges`
3. 对返回的每条候选边，校验 `source` / `target` 节点存在后，添加 `transforms` 或 `validates` 边

缓存 key：`semantic-edges:<filePath>:<contentHash>`

#### 导出 D 层数组

```typescript
export const D_LAYER_ENRICHERS: GraphEnricher[] = [
  summaryEnricher,
  conceptNamingEnricher,
  architectureLayerEnricher,
  semanticEdgeEnricher,
];
```

---

### 3.7 `src/index.ts`

#### `AgentConfig` 增加

```typescript
export interface AgentConfig {
  // ... existing fields
  semanticEnrichment?: boolean;
}
```

#### CLI 选项

`init` 和 `sync` 命令增加：

```typescript
.option('--semantic', 'Enable D-layer LLM semantic enrichment', false)
```

#### `init()` 中启用 D 层

```typescript
const enabledLayers: EnrichLayer[] = ['A', 'B'];
if (emb) enabledLayers.push('C');
if (this.config.semanticEnrichment) enabledLayers.push('D');

const llmCache = new LlmSemanticCache(this.memory.getLlmSemanticCache());

await runEnrichers(
  builder,
  fingerprints,
  {
    enabledLayers,
    assetFiles,
    sources,
    llm: this.llmService,
    embeddings: embeddingService,
    llmCache,
  },
  [...A_LAYER_ENRICHERS, ...B_LAYER_ENRICHERS, ...C_LAYER_ENRICHERS, ...D_LAYER_ENRICHERS]
);

this.memory.setLlmSemanticCache(llmCache.export());
```

> `syncRepo` 中同步修改。

---

### 3.8 Prompt 设计（Anthropic/Http provider）

#### summarizeNode

```
You are a code documentation assistant. Given a code symbol, write a concise one-sentence summary and 1-5 relevant tags.

Node type: {nodeType}
Name: {name}
Signature: {signature}
Code snippet:
```
{codeSnippet}
```

Respond ONLY with JSON:
{
  "summary": "one sentence",
  "tags": ["tag1", "tag2"]
}
```

#### nameConceptCluster

```
You are naming a cluster of related code symbols. Choose a short, meaningful 2-4 word concept name.

Members:
- {name1} ({id1})
- {name2} ({id2})
...

Respond ONLY with JSON:
{
  "name": "AuthSession",
  "rationale": "all members manage authentication session lifecycle"
}
```

#### classifyArchitectureLayer

```
Classify the following code file/symbol into one architecture layer: api, service, data, ui, utility, or unknown.

Name: {name}
Signature: {signature}
Neighbors: {neighbors}

Respond ONLY with JSON:
{
  "layer": "service",
  "confidence": 0.85
}
```

#### detectSemanticEdges

```
Analyze the following functions and identify semantic relationships:
- "transforms": function A converts/changes data and passes result to function B
- "validates": function A checks/constrains input before function B uses it

Functions:
- {name}({signature}): {bodySnippet}
...

Respond ONLY with JSON:
{
  "edges": [
    {"source": "function:file:validateInput", "target": "function:file:processInput", "type": "validates", "confidence": 0.9}
  ]
}
```

---

## 4. 测试计划

### 4.1 单元测试：`tests/graph-enrich-d.test.ts`

使用 `TemplateLlmService` 验证接线：

- `summaryEnricher` 更新 function/class/file 节点的 `summary` 和 `tags`
- `conceptNamingEnricher` 重命名 C 层匿名簇
- `architectureLayerEnricher` 创建 `concept:layer:*` 节点和 `related` 边
- `semanticEdgeEnricher` 创建 `transforms` / `validates` 边
- D 层未启用时（`enabledLayers` 不含 `'D'`）不运行
- 缺少 `ctx.llm` 时 enricher 静默跳过

### 4.2 缓存测试：`tests/llm-semantic-cache.test.ts`

- `LlmSemanticCache.get/set`
- 跨 `export`/`load` 持久化命中
- key 按节点/文件 hash 失效

### 4.3 集成测试：`tests/cli.test.ts`

新增一个测试：

```typescript
it('enables D-layer semantic enrichment with --semantic', async () => {
  const agent = new CodeRepairAgent({ provider: 'template', semanticEnrichment: true });
  await agent.init(fixturePath);
  const graph = agent.getMemory().getKnowledgeGraph();
  expect(graph.nodes.some(n => n.type === 'concept' && n.id.startsWith('concept:layer:'))).toBe(true);
});
```

### 4.4 真实 API eval：`scripts/eval-d-layer.mjs`

```javascript
import { CodeRepairAgent } from '../src/index.js';

const agent = new CodeRepairAgent({ provider: 'anthropic', semanticEnrichment: true });
await agent.init('./tests/fixtures/sample-repo');
const graph = agent.getMemory().getKnowledgeGraph();

console.log('=== Concept clusters ===');
for (const n of graph.nodes.filter(n => n.type === 'concept' && n.id.startsWith('concept:cluster:'))) {
  console.log(n.name, n.summary, n.tags);
}

console.log('=== Layers ===');
for (const n of graph.nodes.filter(n => n.type === 'concept' && n.id.startsWith('concept:layer:'))) {
  console.log(n.name, 'members:', graph.edges.filter(e => e.target === n.id && e.type === 'related').length);
}

console.log('=== Semantic edges ===');
for (const e of graph.edges.filter(e => e.type === 'transforms' || e.type === 'validates')) {
  console.log(e.source, e.type, e.target, e.weight);
}
```

运行：`node scripts/eval-d-layer.mjs`（需 `ANTHROPIC_API_KEY`）。

---

## 5. Definition of Done

- [ ] `npx tsc --noEmit` 通过
- [ ] `npx vitest run` 全绿（含新增测试）
- [ ] `code-agent init --semantic` 命令可用
- [ ] `code-agent sync --semantic` 命令可用
- [ ] `scripts/eval-d-layer.mjs` 在真实 API key 下运行成功
- [ ] eval 输出经人工 review，cluster name / summary / layer 分类合理
- [ ] `PROGRESS.md` 更新：D 层标记为完成

---

## 6. 风险与回退

| 风险 | 缓解 |
|------|------|
| 真实 API key 不可用 | D 层默认关闭；Anthropic/Http 失败自动 fallback template |
| LLM 输出不稳定 | 所有结果按 content hash 缓存，跨 sync 复用 |
| Token 消耗过高 | 默认关闭；`--semantic` 显式开启；可后续加 `--semantic-budget` |
| 架构分层错误 | 以 `confidence` 作为边权重，低置信度可过滤 |
| 测试全绿但语义无意义 | DoD 强制要求真实 API eval + 人工 review |

---

*本文档确认后，按第 3 节文件顺序实现即可。*
