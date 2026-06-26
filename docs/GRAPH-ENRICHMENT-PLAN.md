# 知识图谱语义增强 — 实施方案

> 本文档记录知识图谱「剩余节点/边类型」的构建方案。
> 背景:当前 `src/core/graph-build.ts` 仅构建 4 种节点(file/function/class/module)
> 和 5 种边(contains/imports/exports/calls/inherits);types.ts 定义的 16 种节点 /
> 31 种边中,其余类型「已声明类型,未在运行时构建」。
> 版本: v1.0.0  ·  日期: 2026-06-25

---

## 1. 核心判据

剩余类型**不是一个均质问题**,不应一锅端。唯一的分类依据是:

> **信息能否从语法里还原出来。**
> 能 → 静态提取即可;不能 → 才需要更强手段。
> 「更强手段」再分 **embedding** 和 **LLM** 两档,**绝大多数并不需要 LLM**。

按「信息来源」切成 4 层 + 1 个独立生命周期。

---

## 2. 分层方案

### A 层 · 确定性静态(Tree-sitter / AST / 正则,零 token)

最高 ROI、零依赖,沿用现有 `graph-build.ts` 的 Tree-sitter 路线。

| 类型 | 信息来源 | 预估工时 |
|------|---------|---------|
| 节点 `config`/`document`/`pipeline`/`schema`/`service` | 文件类型分类器(package.json→config、`*.md`→document、`.github/workflows/*`→pipeline、`Dockerfile`→service、`*.sql`/`schema.prisma`→schema) | ~4h |
| 边 `implements` | AST:`class X implements Y`,与现有 `inherits` 同构 | ~1h |
| 边 `tested_by` | 已有 import 边 + 测试命名(`*.test.ts` 导入源文件) | ~2h |
| 边 `depends_on` | 模块级 import 聚合(function 边上卷到 file/module) | ~2h |

### B 层 · 框架感知静态(pattern extractor,零 token)

按项目技术栈选做。**pub/sub/middleware 属于此层,非 LLM。**

| 类型 | 信息来源 | 预估工时 |
|------|---------|---------|
| 节点 `endpoint` + 边 `routes` | 框架特定:Express/Fastify 路由、装饰器 `@Get` | ~6h/框架 |
| 节点 `table` + 边 `defines_schema` | Prisma/TypeORM model、SQL DDL | ~6h/ORM |
| 边 `subscribes`/`publishes`/`middleware` | `bus.on`/`bus.emit`/`app.use` 模式 | ~4h |
| 边 `reads_from`/`writes_to`(**API 模式子集**) | `db.query`/`fs.writeFile` 等确定性调用 | ~4h |

### C 层 · Embedding(向量相似度,零 token,可本地)

**不是 LLM 依赖**——需要的是嵌入模型,经本地 ONNX(transformers.js)零 token 运行。

| 类型 | 信息来源 |
|------|---------|
| 边 `similar_to`/`related` | 节点向量余弦相似度(阈值分带) |
| 节点 `concept` 的**成员聚类** | 向量聚类(谁与谁归一组,**命名留给 D 层**) |

> 完整设计见 **§7 C 层详细设计**(已定稿,可直接开工)。

### D 层 · LLM 语义(经 `LlmService`,需真实 API 才有质量)

真正需要 LLM 的**窄子集**——表达的是「语法之外的意图」,模式匹配无法替代理解。

| 类型 | 为什么静态/embedding 都不够 |
|------|---------------------------|
| 节点 `concept` 的**命名** | 「这簇叫 session-refresh」是语法外的意图;embedding 能聚类,说不出名字 |
| 架构分层 / 业务域映射 | 「这是 Service 层还是 Data 层」是人为意图,需理解非匹配 |
| 边 `transforms`/`validates`(**意图子集**) | 「是否在校验业务规则」需语义判断 |
| 节点摘要 / 标签 | 生成式任务,定义上需 LLM |

### 独立生命周期 · 非 graph-build(分析/学习管线)

这些是**运行时分析/学习产物**,应在 detect/plan/learn 阶段写入图谱,**不是结构构建期的职责**。

| 类型 | 写入时机 |
|------|---------|
| 节点 `fault`/`fix`/`pattern` | FaultDetector / SolutionPlanner / PatternExtractor |
| 边 `fixes`/`mitigates`/`relates_to_fault`/`suggests`/`learned_from` | 同上 |

---

## 3. 架构:GraphEnricher 管线

保持 `graph-build.ts` 为**确定性内核**,把增强逻辑做成可插拔、可单独测试、可按技术栈开关的 enricher。

```
buildGraphFromFingerprints(fingerprints)        // 确定性内核(现有)
        │  产出 file/function/class/module + contains/imports/exports/calls/inherits
        ▼
GraphEnricher.run(builder, fingerprints, ctx)   // 新增:依次跑注册的 enricher
        ├── A 层 enrichers   (静态,零 token)
        ├── B 层 enrichers   (框架感知,零 token,按技术栈启用)
        ├── C 层 enricher    (embedding,需 EmbeddingService)
        └── D 层 enricher    (语义,需 LlmService)
        ▼
builder.build()                                  // 最终图谱
```

**接口草案**

```typescript
interface GraphEnricher {
  readonly name: string;
  readonly layer: 'A' | 'B' | 'C' | 'D';
  enrich(builder: KnowledgeGraphBuilder, fingerprints: Record<string, FileFingerprint>, ctx: EnrichContext): Promise<void>;
}

interface EnrichContext {
  llm?: LlmService;          // D 层消费;缺失则跳过
  embeddings?: EmbeddingService;  // C 层消费;缺失则跳过
  enabledLayers: Array<'A' | 'B' | 'C' | 'D'>;
}
```

- A/B 层 enricher 是同步纯静态,无外部依赖。
- C 层 enricher 消费 `EmbeddingService`(新增抽象,本地/API 双 Provider)。
- D 层 enricher 消费现有 `LlmService`,缺失 Provider 时静默跳过。

---

## 4. 关键洞察:LLM 依赖是「运行时配置」,不是「实现阻塞」

D 层**现在就能实现**,不需要等真实 LLM。理由——抽象层项目里已具备:

- `LlmService` 接口 + 三 Provider(`Template` / `Anthropic` / `Http`)
- `LlmConfigResolver` 统一配置(env / 用户配置分层、API key 脱敏)
- `FaultDetector` / `SolutionPlanner` / `PatchGenerator` **早已是这么写的**——针对接口编码,换真实 Provider 即从模板桩升级为真语义。

**D 层就是再加一个 `LlmService` 的消费者。** 落地三步:

1. 给 `LlmService` 接口加语义方法(如 `extractConcepts` / `analyzeSemantics`),三 Provider 全实现——`Template` 给**确定性浅桩**(保证结构合法、可测接线),`Anthropic`/`Http` 给真实 prompt。
2. 写 D 层 `GraphEnricher`,消费 `LlmService`,把返回映射成节点/边。
3. 用 fingerprint 缓存(复用 `ResultCache` 模式)闸住 token——语义分析按文件/簇调用,昂贵,必须缓存。

使用时:配真实 API key → 真实语义;配模板桩 → 降级浅输出。**与现有架构完全一致。**

### ⚠️ Definition-of-Done 警告

模板桩会让 D 层测试**全绿**,但**绿 ≠ 功能真的可用**。模板桩做模式匹配,对「概念命名/业务域映射」会产出结构合法但语义无意义的结果。

> **D 层「完成」判定必须包含一次真实 API 的 eval**(拿真 key 跑、人看输出),不能只靠模板桩测试通过就宣布完成。

(同类陷阱:`ResultCache` 曾有 "across tasks" 注释夸大实际进程内行为。别让桩的绿灯冒充真实能力。)

---

## 5. 执行顺序建议

| 优先级 | 层 | 依赖 | token | 说明 |
|--------|----|------|-------|------|
| 1 | **A 层** | 无 | 零 | ✅ **已完成** — GraphEnricher 骨架 + implements/tested_by/depends_on + 文件分类器节点 |
| 2 | **B 层** | 框架特定 | 零 | ✅ **已完成** — routes/events/middleware/data-access/tables(经 `EnrichContext.sources` 读源码) |
| 3 | **C 层** | EmbeddingService(本地) | 零 | ✅ **完成** — similar_to/related 边 + 匿名 concept 聚类 + fingerprint 键缓存,已接 init/sync + CLI `--embeddings`。**#5 真实 ONNX 模型(bge-small,经 `@huggingface/transformers` 懒加载)+ DoD eval 已达成**(§7.8)。详见 §7 |
| 4 | **D 层** | LlmService | 需 API 才有质量 | 🔲 **下一步** — **可与 C 并行**;配置层已就绪,DoD 须含一次真实 API eval(见 §4 警告) |

**独立生命周期**(fault/fix/pattern)随分析管线演进,不在本计划主线。

### 5.1 C/D 层交接说明(新会话从此处接)

骨架与接线已就绪,C/D 只需「新增 enricher + 在 context 注入对应 Provider」:

- **管线已在 `src/core/graph-enrich.ts`**:实现 `GraphEnricher` 接口(`name`/`layer`/`enrich`),追加到 `C_LAYER_ENRICHERS`/`D_LAYER_ENRICHERS` 数组即可。
- **接线点**:`src/index.ts` 的 `init()` 与 `src/core/sync.ts` 的 `syncRepo()` 调用 `runEnrichers(builder, fingerprints, ctx, [...A, ...B, ...])`;C/D 上线时把 `enabledLayers` 加 `'C'`/`'D'`、把 `embeddings`/`llm` 注入 `ctx`,并把对应数组拼进 enricher 列表。
- **`EnrichContext` 已留位**:`embeddings?`(C 层消费)、`llm?`(D 层消费),缺失 Provider 时 enricher 应自跳过(参照 B 层缺 `sources` 自跳过)。
- **C 层**:需新增 `EmbeddingService` 抽象(本地 ONNX/`all-MiniLM` 或 API 双 Provider),enricher 算节点向量余弦相似度产 `similar_to`/`related` 边、对 function/class/file 节点聚类。
- **D 层**:给 `LlmService` 接口加语义方法(如 `extractConcepts`/`analyzeSemantics`),三 Provider 全实现(Template 给确定性浅桩、Anthropic/Http 给真 prompt);enricher 产 `concept` 命名/架构分层/`transforms`·`validates` 意图边/节点摘要。**⚠️ 完成判定必须含一次真实 API eval,模板桩全绿 ≠ 可用(见 §4)。**
- **缓存**:C/D 昂贵,产物建议用 fingerprint 键缓存(复用 `ResultCache` 模式),避免每次 sync 重算。

---

## 6. 与现有模块的衔接点

- `init`(全量)与 `sync`(增量)均调用 `buildGraphFromFingerprints` → 在其后插入 `GraphEnricher.run`,保持单一真相源、两路径不漂移。
- 传播引擎 `PROPAGATION_RULES` 已对全部 31 种边类型有规则——新边一旦构建,传播立即可触达,无需改 propagation.ts。
- C/D 层产物建议受 fingerprint 缓存保护,避免每次 sync 重算。

---

## 7. C 层详细设计(定稿 · 2026-06-26)

> 范围已定:**similar_to/related 相似边 + 匿名 concept 聚类**(聚类只分组,不命名;命名属 D 层)。
> 后端:`LocalEmbeddingService`(ONNX/transformers.js,零 token),`TemplateEmbeddingService` 桩先行接线。

### 7.1 产出

| 产出 | 类型(已声明) | 规则 |
|------|------------|------|
| `similar_to` 边 | types.ts:40 · propagation.ts:66(双向) | 同类型节点对余弦 ≥ 0.85,weight=cos |
| `related` 边 | types.ts:39 · propagation.ts:65(双向) | 0.70 ≤ 余弦 < 0.85,weight=cos |
| `concept:cluster:<hash>` 节点 + 成员 `related` 边 | concept(types.ts:9) | 阈值贪心聚类(连通分量,cos ≥ 0.80),簇 size ≥ 2 才建;name 占位=成员公共 token |

边界:C 只回答「谁和谁相似/归一簇」。「这簇叫什么」是语法外意图 → D 层 `rename`。两层解耦,可并行。

### 7.2 嵌入文本构造(节点 → 文本)

构建期 `summary` 仍为空(D 层产物),C 层用当下可得的确定性文本。嵌入单元限 `function`/`class`/`file`:

```
function 节点 → `${name}(${params}) -> ${returnType}` + 调用点名列表
class    节点 → `${name}` + 方法名 + 属性名 + 父类/接口名
file     节点 → basename + 导出符号名 + 顶层注释(取自 ctx.sources 前 N 行)
```

全部来自 fingerprint(签名)+ `ctx.sources`(B 层已采集,复用,不新增扫描)。

### 7.3 `EmbeddingService` 抽象(镜像 `LlmService` 三 Provider 模式)

```typescript
// src/core/embedding-service.ts (新增)
interface EmbeddingService {
  readonly dimensions: number;          // Provider 自报维度
  embed(texts: string[]): Promise<number[][]>;   // 批量,返回 L2 归一化向量
}
```

| Provider | 用途 | token | 依赖 |
|----------|------|-------|------|
| `TemplateEmbeddingService` | **桩**:确定性 char n-gram 哈希向量,保证接线/缓存/阈值可测 | 零 | 零依赖 |
| `LocalEmbeddingService` | **真实**:ONNX,**默认 `bge-small-en-v1.5`**(384 维,~34MB q8 量化) | 零 | `@huggingface/transformers`(optional dep,懒加载) |
| `ApiEmbeddingService` | 可选:OpenAI/Voyage/Cohere | 有 | API key |

配置走现有 `LlmConfigResolver` 分层(env/用户配置 + key 脱敏),不重造。

**模型选型**(`LocalEmbeddingService` 的 config,非硬编码,可换):

| 模型 | 维度 | 体积 | 代码感知 | 定位 |
|------|------|------|---------|------|
| **bge-small-en-v1.5**(默认) | 384 | ~33MB | ❌ 通用 | 质量/体积最优解(MTEB~62);需查询前缀 |
| all-MiniLM-L6-v2 | 384 | ~23MB | ❌ 通用 | 零风险回退,端口最稳最小 |
| jina-embeddings-v2-base-code | 768 | ~160MB | ✅ 30 语言 | **将来嵌入完整代码体时**的升级项 |

判据:C 层嵌入的是**短签名/符号名**,非大段代码体 → 通用强小模型性价比最高;`jina-code` 的代码理解优势在整段代码体上才显著,当下不划算。`dimensions` 由 Provider 自报,相似度/缓存逻辑全模型无关。

### 7.4 `embeddingsEnricher` 算法

```
1. 收集 function/class/file 节点 → 构造文本(§7.2)
2. 命中缓存的跳过(§7.5),未命中的批量 embed
3. 相似边:同类型节点对算余弦(function↔function / class↔class / file↔file)
   - cos ≥ 0.85           → similar_to (weight=cos)
   - 0.70 ≤ cos < 0.85    → related    (weight=cos)
   - 每节点只保留 top-K(K=5)出边,封顶规模
4. 聚类:阈值贪心(cos ≥ 0.80 连通分量),簇 size ≥ 2 才建
   - concept:cluster:<stableHash> 节点(name 占位=成员公共 token)
   - 成员 → 簇 加 related 边
```

`related` vs `similar_to` 用**阈值带**区分:高相似=近重复/可复用候选,中相似=主题关联。简单、可解释、无需额外信号。

### 7.5 缓存(fingerprint 键,复用 `ResultCache`/`SemanticCache` 模式)

嵌入即便本地也有模型加载+推理成本,**必须缓存**:
- 每节点向量按其所属文件 `contentHash` 缓存,序列化进 `memory.json`(参照 `SemanticCache` 跨进程持久化)。
- `sync` 只对变更文件的节点重新 embed —— 与指纹增量天然对齐。

### 7.6 复杂度与规模护栏

朴素两两相似 O(n²)。护栏:
- **仅同类型内**比较(缩小基数)。
- 节点数超阈值(如 >2000)→ `log()` 告警并降级(分桶 top-K),**绝不静默截断**(项目 no-silent-caps 原则)。
- top-K 出边封顶,避免稠密图拖垮传播引擎。

### 7.7 接线(两处单一真相源)

- `src/index.ts`(init)与 `src/core/sync.ts`(syncRepo):`enabledLayers` 加 `'C'`、`ctx.embeddings` 注入 Provider、enricher 列表拼 `...C_LAYER_ENRICHERS`。
- **默认关闭**:C 有依赖/模型加载成本,仅当配置了 embedding provider 才启用(缺失则 enricher 自跳过,照搬 B 层缺 `sources` 范式)。
- CLI:`--embeddings` 开关 + config 选 backend/模型。

### 7.8 测试 + ⚠️ DoD 警告

- 单测用 `TemplateEmbeddingService`:验证接线、阈值分带、top-K 封顶、缓存命中、自跳过 —— 可全绿。
- **与 D 层同一陷阱**:哈希桩的「相似度」无语义,**全绿 ≠ 可用**。
  > **C 层「完成」判定必须含一次真实 `bge-small`/`all-MiniLM` 跑 + 人看 `similar_to` 边是否合理**。模板桩只证明「接线对」,不证明「相似对」。

**✅ DoD 已达成(2026-06-26,真实 `bge-small-en-v1.5` q8)。** 见 `scripts/eval-embeddings.mjs`(可复现)+ `tests/embedding-service.test.ts` 的 `LocalEmbeddingService (real ONNX model — DoD eval)`(模型存在时自动启用,缺失则跳过不静默通过)。eval 结论——真实模型对**语义相关但词法不同**的签名对正确分带,桩则漏判:

| 签名对(词法差异大) | 真实模型 cos / band | 模板桩 cos / band |
|---|---|---|
| `authenticate(user,password)` ~ `login(credentials)` | **0.878 / similar_to** | 0.571 / —(漏) |
| `class HttpClient{...}` ~ `class ApiRequester{...}` | **0.703 / related** | 0.349 / —(漏) |
| `deleteFile(path)` ~ `removeDocument(uri)` | **0.754 / related** | 0.582 / —(漏) |
| `getUserById` ~ `renderTriangle`(无关) | 0.419 / —(对) | 0.260 / —(对) |

真实仓库 `init --embeddings local` 端到端验证:`authenticate→login` 产 `related` 边(w=0.834)、跨类型 `concept:cluster` 聚类成形、`embeddingCache` 持久化进 `memory.json`、`sync` 未变文件零嵌入(全缓存命中)。**桩在同一对上不产边——证明真实模型带来的是语义而非词法重叠。**

> **离线/受限网络**:HF Hub 不可达时,用 `scripts/fetch-embedding-model.sh`(默认走 `hf-mirror.com`)预下载到 `./models`,经 `EMBEDDING_MODEL_PATH` 加载;或设 `HF_ENDPOINT` 走镜像。模型不入 git(`.gitignore: models/`)。

### 7.9 任务分解(~16h)

| # | 任务 | 工时 | 状态 |
|---|------|------|------|
| 1 | `EmbeddingService` 接口 + `TemplateEmbeddingService` 桩 + config 接入 | ~2h | ✅ 完成 |
| 2 | `embeddingsEnricher`:文本构造 + 相似边(similar_to/related + top-K) | ~3h | ✅ 完成 |
| 3 | 聚类 → 匿名 concept 簇节点 | ~2h | ✅ 完成 |
| 4 | fingerprint 键缓存(memory.json 持久化 + sync 增量) | ~3h | ✅ 完成 |
| 5 | `LocalEmbeddingService`(ONNX bge-small)+ 真实 eval | ~4h | ✅ **完成** |
| 6 | 接线(init/sync/CLI `--embeddings`)+ 测试 + 文档 | ~2h | ✅ 完成 |

#1-6 全部完成。**#5 已接真实 ONNX 模型并通过 DoD eval(§7.8):`LocalEmbeddingService` 经 `@huggingface/transformers` 懒加载 bge-small-en-v1.5(q8,384 维),`@huggingface/transformers` 为 optional dep(native onnxruntime 装失败不阻断构建);离线/镜像支持齐备。C 层至此「真完成」——非桩全绿冒充。**

---

*本文档为后续开工依据,随实施进展更新。A/B 层已完成(见 PROGRESS.md #57/#58),C 层全部完成(#59 桩接通 + #60 真实 ONNX 模型 + DoD eval,init/sync/CLI 全接线);D 层待实施。*
