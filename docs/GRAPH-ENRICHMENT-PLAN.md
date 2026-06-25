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

**不是 LLM 依赖**——需要的是嵌入模型,可用本地 `all-MiniLM`(ONNX,~20MB)零 token 运行。

| 类型 | 信息来源 |
|------|---------|
| 边 `similar_to`/`related` | 节点向量余弦相似度 |
| 节点 `concept` 的**成员聚类** | 向量聚类(谁与谁归一组) |

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
| 1 | **A 层** | 无 | 零 | 最确定,立即做(~9h),先把 GraphEnricher 骨架立起来 |
| 2 | **B 层** | 框架特定 | 零 | 按项目技术栈选做 |
| 3 | **C 层** | EmbeddingService(本地) | 零 | 解锁 similar_to / concept 聚类 |
| 4 | **D 层** | LlmService | 需 API 才有质量 | **可与 A/B 并行实现**,标记「质量待真实 API eval」;配置层已就绪,无需等待 |

**独立生命周期**(fault/fix/pattern)随分析管线演进,不在本计划主线。

---

## 6. 与现有模块的衔接点

- `init`(全量)与 `sync`(增量)均调用 `buildGraphFromFingerprints` → 在其后插入 `GraphEnricher.run`,保持单一真相源、两路径不漂移。
- 传播引擎 `PROPAGATION_RULES` 已对全部 31 种边类型有规则——新边一旦构建,传播立即可触达,无需改 propagation.ts。
- C/D 层产物建议受 fingerprint 缓存保护,避免每次 sync 重算。

---

*本文档为后续开工依据,随实施进展更新。*
