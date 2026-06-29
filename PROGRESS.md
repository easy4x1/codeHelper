# Code Repair Agent — 实现进度报告

> 生成日期: 2026-06-03（最后更新: 2026-06-29，D 层语义增强完成）
> 对比基准: DESIGN.md v1.0.0
> 当前版本: 0.5.0 (Phase 5 学习与进化完成)

---

## 总体完成度

| 阶段 | 计划内容 | 完成状态 |
|------|---------|---------|
| Phase 1: MVP（核心闭环）| 核心 Agent + CLI + 基础图谱 + Patch/Review 流程 | **100%** |
| Phase 2: 记忆优化 | Fingerprint 增量、传播裁剪、Token 预算 | **100%** |
| Phase 3: 联网增强 | Web Search、结果融合、LLM Patch 生成、搜索降级、Batch 并行、结果缓存、语义缓存、上下文压缩 | **100%** |
| Phase 4: 自动化与集成 | Git 自动化、CI/CD、批量任务 | **核心完成 (~85%)** |
| Phase 5: 学习与进化 | 模式提取、项目约定学习、个性化推荐 | **100%** |

**整体完成度: ~95%**

---

## 1. 系统架构实现状态

### 1.1 核心 Agent（8 个计划中）

| Agent | 职责 | 状态 | 说明 |
|-------|------|------|------|
| `repo-scanner` | 扫描仓库，提取文件、依赖、指纹 | ✅ **已完成** | `RepoScannerAgent` 类实现，集成 `scanRepo()` 和 `buildImportMap()` |
| `fault-detector` | 定位代码中的问题点 | ✅ **LLM 增强** | 启发式 + `TemplateLlmService` 语义分析（6 种检测模式） |
| `context-builder` | 召回与问题相关的代码上下文 | ✅ **已完成** | `ContextBuilderAgent` 实现，基于知识图谱邻居遍历 |
| `web-searcher` | 联网搜索解决方案 | ✅ **已完成** | `WebSearcherAgent` + `WebSearchEngine` + 模拟搜索 provider |
| `root-cause-analyzer` | 综合分析，定位根因 | ✅ **已完成** | 独立 `RootCauseAnalyzerAgent`，职责从 `SolutionPlannerAgent` 分离 |
| `solution-planner` | 输出结构化修改方案 | ✅ **LLM 增强** | 生成带 `originalCode`/`modifiedCode` 的深度方案 |
| `patch-generator` | 将方案转换为具体代码 diff | ✅ **已完成** | `PatchGeneratorAgent` 实现，支持 add/modify/delete |
| `git-executor` | 执行 git 操作 | ✅ **已完成** | `GitExecutor` + `GitExecutorAgent`，分支创建/提交/推送 |
| `learning-agent` | 学习项目约定、提取模式 | ✅ **新增** | `LearningAgent` 协调 PatternExtractor + ConventionLearner + RecommendationEngine |

### 1.2 核心模块实现状态

| 模块 | 设计内容 | 状态 | 文件 |
|------|---------|------|------|
| **知识图谱 (Knowledge Graph)** | 13 种节点类型、31 种边类型 | ✅ 已完成 | `src/core/knowledge-graph.ts` |
| **文件指纹 (Fingerprint)** | SHA-256 + 结构签名 + 变更分类 | ✅ **Tree-sitter 增强** | `src/core/fingerprint.ts` |
| **记忆中间层 (Memory)** | L1/L2/L3 三层架构 | ✅ 已完成 | `src/core/memory.ts` |
| **增量同步 (Sync)** | 基于指纹的自动增量更新 | ✅ **已完成** | `src/core/sync.ts` + `code-agent sync` CLI |
| **LLM 服务** | 抽象接口 + 模板模拟实现 | ✅ **已完成** | `src/core/llm-service.ts` |
| **故障传播分析** | 沿调用链传播分析、影响概率 | ✅ **已完成** | `src/core/propagation.ts` + `ContextBuilderAgent` 集成 |
| **Token 预算控制** | 动态降级策略、预算分配 | ✅ **已完成** | `src/core/token-budget.ts` + CLI `--budget` |
| **联网搜索** | 查询生成、结果融合 | ✅ **已完成** | `src/core/web-search.ts` + 4 种查询模板 + 加权融合策略 |
| **方案生成** | 结构化方案 + 风险评估 | ✅ **LLM 增强** | `src/agents/solution-planner-agent.ts` |
| **Patch 生成** | 方案转代码 diff + 应用 | ✅ 已完成 | `src/core/patch.ts` + `src/agents/patch-generator-agent.ts` |
| **Review 与执行** | 终端 diff 展示 + 用户确认 | ✅ 已完成 | `src/interface/cli-review.ts` + `src/index.ts` apply/fix 命令 |
| **模式提取 (Pattern Extractor)** | 从 findings/plans 提取可复用模式 | ✅ **新增** | `src/core/pattern-extractor.ts` |
| **约定学习 (Convention Learner)** | 从代码指纹学习命名/测试/架构约定 | ✅ **新增** | `src/core/convention-learner.ts` |
| **推荐引擎 (Recommendation Engine)** | 任务-模式相似度评分与排序 | ✅ **新增** | `src/core/recommendation-engine.ts` |
| **学习 Agent (Learning Agent)** | 协调学习流程：约定+模式+推荐 | ✅ **新增** | `src/agents/learning-agent.ts` |

---

## 2. 本次迭代完成（2026-06-02）

### 2.1 任务 1: Tree-sitter 集成 ✅

**变更文件**: `src/core/fingerprint.ts`

**实现内容**:
- 使用 Tree-sitter AST 解析替代正则表达式提取
- 支持 TypeScript (`.ts`)、TSX (`.tsx`)、JavaScript (`.js`/`.jsx`)、Python (`.py`)
- 准确提取函数签名（名称、参数、返回类型、导出状态、**精确行范围**）
- 准确提取类签名（名称、方法列表、属性列表、导出状态、精确行范围）
- 准确提取导入签名（named/default/namespace 导入）
- 准确提取导出签名（函数/类/变量/default 导出）
- 保留正则回退机制（不支持的文件类型自动降级）

**影响**:
- `FunctionSignature.endLine` 不再始终等于 `startLine` ✅
- `ClassSignature.methods` 和 `properties` 现在被正确填充 ✅
- `FunctionSignature.returnType` 现在被正确提取 ✅

### 2.2 任务 2: `code-agent sync` 增量同步 ✅

**新增文件**:
- `src/core/sync.ts` — 增量同步核心逻辑

**变更文件**:
- `src/index.ts` — 新增 `sync` CLI 命令
- `src/core/knowledge-graph.ts` — 添加 `removeNode`, `removeEdge`, `removeEdgesByNode` 方法

**实现内容**:
- 自动比对现有指纹 vs 当前文件状态
- 按变更分类执行对应策略：NONE(跳过) / COSMETIC(更新哈希) / STRUCTURAL(重建图谱)
- 检测新增文件和删除文件
- `--force-full` 选项强制全量重分析
- 遵循 LOAD-PATCH-SAVE 模式更新指纹存储
- 更新后的图谱和指纹自动持久化到 `.repair-agent/memory.json`

### 2.3 任务 3: LLM 增强 FaultDetector 和 SolutionPlanner ✅

**新增文件**:
- `src/core/llm-service.ts` — LLM 服务抽象 + `TemplateLlmService` 实现

**变更文件**:
- `src/agents/fault-detector-agent.ts` — 集成 LLM 语义分析
- `src/agents/solution-planner-agent.ts` — 集成 LLM 方案生成

**实现内容**:
- `LlmService` 抽象接口（`analyzeFault` + `generateSolution`）
- `TemplateLlmService` 模板模拟实现（6 种故障检测模式）:
  - 空指针/未定义引用检测
  - 未使用变量检测
  - `console.log` 使用检测
  - TODO/FIXME 注释检测
  - `any` 类型使用检测
  - 空 catch 块检测
- `SolutionPlanner` 现在生成带 `originalCode`/`modifiedCode` 的修改方案
- 自动根据发现类型推断严重级别（critical/high/medium）
- `AnthropicLlmService` 占位类（Phase 3+ 接入真实 API）

### 2.4 任务 4: 故障传播分析引擎 ✅

**新增文件**:
- `src/core/propagation.ts` — 传播引擎核心（BFS + 概率衰减）
- `tests/propagation.test.ts` — 9 个测试用例

**变更文件**:
- `src/core/types.ts` — 添加 `PropagationOptions`, `AffectedNode`, `PropagationResult` 等类型
- `src/core/knowledge-graph.ts` — 添加公开方法 `getEdgesBySource` / `getEdgesByTarget`
- `src/agents/context-builder-agent.ts` — 集成传播引擎自动召回相关节点
- `tests/agents.test.ts` — 添加传播集成测试

**实现内容**:
- 31 种边类型传播规则（contains/calls/imports/inherits 等）
- 支持 `upstream` / `downstream` / `both` 三种传播方向
- 影响概率 = 当前概率 × 边权重，多路径取最大值
- `maxDepth` 和 `minEdgeWeight` 可配置
- 测试文件自动排除（`includeTests` 选项）
- 根因候选生成（upstream-most 节点）

### 2.5 任务 5: Token 预算控制 ✅

**新增文件**:
- `src/core/token-budget.ts` — Token 预算管理器
- `tests/token-budget.test.ts` — 15 个测试用例

**变更文件**:
- `src/core/types.ts` — 添加 `TokenBudgetConfig`, `TokenBudgetStatus`, `DegradationLevel`, `BudgetRecommendations`
- `src/index.ts` — 集成预算检查到 `plan()` / `fix()` 流程，添加 CLI `--budget` 选项
- `tests/cli.test.ts` — 添加预算集成测试

**实现内容**:
- 四级预算降级策略：
  - 70% 使用 → `reduce_depth`（maxDepth 从 3 降到 2）
  - 80% 使用 → `disable_search`（禁用联网搜索）
  - 90% 使用 → `core_only`（maxDepth=1，最多 3 个文件）
  - 95% 使用 → `prompt_user`（停止执行，提示用户）
- 分类跟踪：analysis / search / planning / review
- 分类上限警告：超支时自动日志告警
- CLI `--budget` 选项支持自定义总预算
- 默认配置：50k tokens（analysis 40%, planning 30%, search 20%, review 10%）

### 2.6 任务 6: 联网搜索模块 ✅

**新增文件**:
- `src/core/web-search.ts` — Web 搜索引擎核心（查询构建 + 模拟搜索 provider）
- `src/agents/web-searcher-agent.ts` — WebSearcherAgent
- `tests/web-search.test.ts` — 13 个测试用例
- `tests/web-searcher-agent.test.ts` — 3 个测试用例

**变更文件**:
- `src/core/types.ts` — 添加 `WebSearchQuery`, `WebSearchResult`, `SearchTemplate`, `WebSearchStrategy` 类型 + Zod schemas
- `src/core/memory.ts` — 添加 `searchCache` 到 L2 + `recordSearchResult` / `getCachedSearchResults`
- `src/index.ts` — 集成 `WebSearcherAgent` 到 `plan()` 流程 + `--web-search` / `--no-web-search` CLI 选项
- `src/agents/solution-planner-agent.ts` — 消费 `searchResults` 作为 LLM 上下文补充

**实现内容**:
- 4 种内置查询模板（error_message / stack_trace / pattern / compatibility）
- 基于置信度的搜索触发策略（localConfidence < 0.5 时触发）
- 模拟搜索 provider（基于关键词返回确定性结果）
- 搜索结果可信度评分 + 排序
- 加权融合策略配置（localKnowledge / webSearch / historicalFix）
- CLI 默认启用搜索，可通过 `--no-web-search` 禁用

### 2.7 任务 7: LLM Patch 生成增强 ✅

**新增文件**:
- `tests/patch-llm.test.ts` — 3 个测试用例

**变更文件**:
- `src/core/llm-service.ts` — `LlmService` 接口添加 `generatePatch`；`TemplateLlmService` / `AnthropicLlmService` / `HttpLlmService` 全部实现
- `src/agents/patch-generator-agent.ts` — 构造函数接受可选 `llm`；缺失 `originalCode`/`modifiedCode` 时自动调用 LLM 生成 diff

**实现内容**:
- `PatchParams` / `PatchLlmResult` 类型定义
- `TemplateLlmService.generatePatch`：基于描述自动推断修复（null safety / logger / type safety）
- `AnthropicLlmService.generatePatch`：调用 Claude API 生成精确 original/modified 代码
- PatchGeneratorAgent LLM 集成：优先使用 plan 中的代码，缺失时调用 LLM，失败时回退到 identity diff

---

## 3. 详细功能对照

### 3.1 知识图谱模块 ✅

| 功能点 | 状态 | 备注 |
|--------|------|------|
| 节点类型（16 种） | ✅ | 包含扩展类型 fault/fix/pattern |
| 边类型（31 种） | ✅ | 包含扩展类型 fixes/mitigates/relates_to_fault 等 |
| GraphBuilder | ✅ | 支持 addNode/addEdge/findNode/findNeighbors/getNodesByType |
| **索引查询** | ✅ **新增** | `nodesByType`/`edgesBySource`/`edgesByTarget` 索引 |
| 图合并 (mergeGraphs) | ✅ | 支持增量更新（LOAD-PATCH-SAVE） |
| 序列化/反序列化 | ✅ | JSON 格式 |
| **节点/边删除** | ✅ **新增** | `removeNode`/`removeEdge`/`removeEdgesByNode` |

### 3.2 指纹模块 ✅

| 功能点 | 状态 | 备注 |
|--------|------|------|
| 内容哈希 (SHA-256) | ✅ | `src/utils/hash.ts` |
| **函数签名提取** | ✅ **Tree-sitter** | 支持 function/箭头函数/async/返回类型/精确行范围 |
| **类签名提取** | ✅ **Tree-sitter** | 类名、方法列表、属性列表、导出状态 |
| **导入/导出提取** | ✅ **Tree-sitter** | 支持 named/default/namespace/side-effect import |
| 三级变更分类 | ✅ | NONE / COSMETIC / STRUCTURAL |
| 语义签名（解耦实现） | ✅ **C 层交付** | 不入指纹，由 `EmbeddingCache`（`<model>:<dim>:<textHash>`）按需计算存储 |
| **Python 支持** | ✅ **新增** | 基础函数/类/导入提取 |

### 3.3 记忆中间层 ✅

| 功能点 | 状态 | 备注 |
|--------|------|------|
| L1: 仓库级静态知识 | ✅ | knowledgeGraph + fingerprints + importMap |
| L2: 任务级动态记忆 | ✅ | taskId + analyzedFiles + recalledNodes + findings |
| L3: 跨任务学习记忆 | ✅ 已完成 | taskHistory + faultPatterns + fixPatterns + projectConventions（Phase 5 填充） |
| 序列化/反序列化 | ✅ | JSON 格式，Set 自动转换 |
| 防御性拷贝 | ✅ | 所有 getter 返回深拷贝 |

### 3.4 仓库扫描器 ✅

| 功能点 | 状态 | 备注 |
|--------|------|------|
| 目录树遍历 | ✅ | 递归扫描，自动忽略 node_modules/.git/dist 等 |
| 源文件过滤 | ✅ | 支持 22 种扩展名 |
| 指纹批量计算 | ✅ | 并行计算 |
| 导入映射构建 | ✅ | 从指纹提取依赖关系 |
| 错误处理 | ✅ | 跳过不可读文件，记录 skippedFiles |
| 符号链接处理 | ✅ | 跳过 symlink 防止循环 |

### 3.5 CLI 接口

| 命令 | 设计 | 状态 | 说明 |
|------|------|------|------|
| `code-agent init [repo-path]` | 初始化仓库扫描 | ✅ **已完成** | 扫描 + 构建图谱 + 持久化内存 |
| `code-agent fix <description>` | 交互式修复（完整闭环） | ✅ **已完成** | plan → patch → review → apply |
| `code-agent plan <description>` | 仅生成方案 | ✅ **已完成** | 生成结构化 SolutionPlan |
| `code-agent status [repo-path]` | 查看图谱状态 | ✅ **已完成** | 显示 nodes/edges/fingerprints 统计 |
| `code-agent apply <plan-id>` | 应用已审核方案 | ✅ **已完成** | 非交互式应用（dry-run 支持） |
| **`code-agent sync [repo-path]`** | **增量同步** | ✅ **新增** | 自动检测变更并增量更新 |
| `code-agent plan <description> --budget` | Token 预算控制 | ✅ **新增** | `--budget <tokens>` 自定义预算 |
| **`code-agent plan <description> --web-search`** | **联网搜索** | ✅ **新增** | `--web-search` / `--no-web-search` 控制 |
| `code-agent history` | 查看历史任务 | ✅ **已完成** | 展示任务历史、故障模式、项目约定 |
| `code-agent learn` | 学习模式 | ✅ **已完成** | 从代码库学习项目约定并持久化 |
| **`code-agent batch <tasks.json>`** | **批量任务处理** | ✅ **已完成** | 顺序/并行模式，autoPush 支持 |
| **`code-agent metrics`** | **性能指标** | ✅ **已完成** | 终端展示指标，支持 `--json` / `--reset` |

### 3.6 Token 优化策略

| 策略 | 设计目标 | 状态 | 备注 |
|------|---------|------|------|
| **Fingerprint 跳过** | 80-95% 节省 | ✅ **已实现** | `syncRepo` 自动跳过未变化文件 |
| **故障传播裁剪** | 70-90% 节省 | ✅ **已实现** | `PropagationEngine` 自动裁剪分析集 |
| **语义缓存** | 60-80% 节省 | ✅ **跨进程持久化** | `SemanticCache` Jaccard 关键词相似度复用历史 plan，entries 序列化进 `memory.json`，CLI 跨命令命中 |
| **增量图谱更新** | 90%+ 节省 | ✅ **已实现** | `syncRepo` 仅更新变化文件节点 |
| **搜索降级** | 100% 搜索 token 节省 | ✅ **新增** | `plan()` 集成 budget `enableWebSearch` 建议 |
| **上下文压缩** | 50-70% 节省 | ✅ **新增** | `ContextCompressor` 大文件结构摘要 |
| **Batch 并行** | 时间节省 | ✅ **新增** | `FaultDetectorAgent` 文件级 `Promise.all` 并行 |
| **结果缓存** | 80%+ 节省 | ✅ **新增** | `ResultCache` 指纹哈希键缓存分析结果 |

---

## 4. 测试覆盖情况

| 测试文件 | 用例数 | 覆盖模块 |
|---------|--------|---------|
| `tests/types.test.ts` | 10 | 核心类型定义（含传播 + 预算类型） |
| `tests/fingerprint.test.ts` | 5 | 指纹计算 + 变更分类 |
| `tests/knowledge-graph.test.ts` | 17 | 图谱构建 + 索引查询 + 合并 + 性能 |
| `tests/memory.test.ts` | 5 | 记忆层 L1/L2/L3 + 序列化 |
| `tests/scanner.test.ts` | 3 | 仓库扫描 + 导入映射 |
| `tests/base-agent.test.ts` | 3 | Agent 基类 + 日志 + 计时 |
| `tests/agents.test.ts` | 8 | 8 个专用 Agent（含 PatchGenerator + 传播集成 + 并行分析 + 缓存集成 + LearningAgent） |
| `tests/cli.test.ts` | 14 | CLI 入口 + 内存持久化 + apply + 预算测试 + 搜索降级 + history/learn |
| `tests/result-cache.test.ts` | 5 | 结果缓存（hit/miss/hash-change/deep-copy/clear） |
| `tests/semantic-cache.test.ts` | 9 | 语义缓存（Jaccard 相似度 + plan 复用 + export/load 持久化 + 淘汰） |
| `tests/context-compressor.test.ts` | 4 | 上下文压缩（小文件透传 + 大文件摘要 + fallback） |
| `tests/pattern-extractor.test.ts` | 3 | 模式提取（fault/fix 模式 + 归一化） |
| `tests/convention-learner.test.ts` | 3 | 约定学习（camelCase/PascalCase/测试命名） |
| `tests/recommendation-engine.test.ts` | 4 | 推荐引擎（相似度评分 + 排序 + 约定） |
| `tests/learning-agent.test.ts` | 2 | 学习 Agent（任务记录 + 约定学习） |
| `tests/patch.test.ts` | 7 | Patch 生成 + 应用 + 冲突检测 |
| `tests/cli-review.test.ts` | 5 | CLI diff 格式化 + Review UI |
| `tests/sync.test.ts` | 5 | 增量同步（新增/删除/不变/强制全量） |
| `tests/llm-service.test.ts` | 12 | LLM 服务 + Zod Context + 多 Provider |
| `tests/propagation.test.ts` | 9 | 故障传播引擎（BFS + 概率 + 方向） |
| `tests/token-budget.test.ts` | 15 | Token 预算（跟踪 + 降级 + 推荐） |
| **`tests/token-estimator.test.ts`** | **9** | **模型感知 Token 估算（国产模型 + 中文自适应）** |
| **`tests/web-search.test.ts`** | **13** | **Web 搜索引擎（查询构建 + 模拟搜索 + 策略）** |
| **`tests/web-searcher-agent.test.ts`** | **3** | **WebSearcherAgent 集成** |
| **`tests/patch-llm.test.ts`** | **3** | **LLM generatePatch（Template + Anthropic）** |
| **`tests/git-executor.test.ts`** | **13** | **GitExecutor 配置 + 安全策略 + remote URL 解析 + PR compare URL 构建** |
| **`tests/root-cause-analyzer-agent.test.ts`** | **4** | **RootCauseAnalyzerAgent 根因分析** |
| **`tests/repair-orchestration.test.ts`** | **7** | **applyPlan/apply/repair 统一编排（review 闸门 + dry-run + 学习记录）** |
| **`tests/graph-build.test.ts`** | **6** | **图谱构建：跨文件 calls/inherits 边 + 符号级 import 解析 + 外部 module 节点** |
| **`tests/context-builder-agent.test.ts`** | **3** | **ContextBuilder 返回 propagationResult + maxPropagationDepth 联动（含 0 深度降级）** |
| **`tests/graph-enrich.test.ts`** | **10** | **GraphEnricher A 层：层级闸门 + implements/tested_by/depends_on 边 + 文件分类器节点** |
| **`tests/graph-enrich-b.test.ts`** | **12** | **GraphEnricher B 层：routes/events/middleware/data-access/tables + 保守模式负例** |
| **`tests/graph-enrich-c.test.ts`** | **12** | **GraphEnricher C 层：similar_to/related 阈值分带 + top-K 剪枝 + 跨类型匿名聚类 + 确定性 id** |
| **`tests/embedding-service.test.ts`** | **32** | **EmbeddingService 桩 + cosine + config 解析 + EmbeddingCache(LRU/持久化) + CachedEmbeddingService(仅 miss 触底) + LocalEmbeddingService 构造 + 真实 ONNX 模型 DoD eval(模型存在时启用,缺失则跳过)** |
| **总计** | **354** | **39 个测试文件**（含 2 个真实 ONNX 模型 DoD 用例，模型缺失时自动跳过；Tavily 网络用例偶发超时与本层无关） |

---

## 5. 已知限制与技术债

### 5.1 当前限制（MVP 预期）

| 限制 | 影响 | 计划解决 |
|------|------|---------|
| **~~正则表达式解析代码~~** | ~~无法处理多行声明、泛型、嵌套结构~~ | ✅ **已解决 — Tree-sitter 替代** |
| **~~FaultDetector 仅为占位实现~~** | ~~无法检测真实故障，仅死代码启发式~~ | ✅ **已解决 — TemplateLlmService 提供 6 种检测模式** |
| **~~SolutionPlanner 无 LLM 参与~~** | ~~生成通用方案，无深度根因分析~~ | ✅ **已解决 — 集成 TemplateLlmService 生成带代码的方案** |
| LLM 为模板模拟（非真实 API） | 检测结果基于启发式模式，非语义理解 | Phase 3+ 接入真实 API（AnthropicLlmService 已就绪）|
| **~~无联网搜索~~** | ~~无法获取外部知识补充~~ | ✅ **已解决 — WebSearchEngine + WebSearcherAgent 实现** |
| **~~联网搜索为模拟 provider~~** | ~~未接入真实 Web Search API~~ | ✅ **已解决 — DuckDuckGoSearchProvider 实现（无需 API key）** |
| **~~无 Git 自动化~~** | ~~不执行分支/提交/推送~~ | ✅ **已解决 — GitExecutor + GitExecutorAgent 实现** |
| **~~无故障传播分析引擎~~** | ~~无法基于图谱计算影响范围~~ | ✅ **已解决 — PropagationEngine 实现** |

### 5.2 技术债

| 优先级 | 问题 | 影响 | 位置 | 建议解决时间 |
|--------|------|------|------|-------------|
| **低** | ~~`AgentInput.context` 为 `Record<string, unknown>`~~ | ~~各 Agent 需做不安全类型转换~~ | ~~所有 Agent 文件~~ | ✅ **已解决 — Zod Schema 验证** |
| **低** | ~~`signaturesEqual` 用 `JSON.stringify` 比较~~ | ~~对嵌套对象不够健壮~~ | ~~`src/core/fingerprint.ts`~~ | ✅ **已解决 — 深度递归比较** |
| **低** | ~~知识图谱邻居查询 O(n²)~~ | ~~大规模图谱性能问题~~ | ~~`src/core/knowledge-graph.ts`~~ | ✅ **已解决 — 索引优化到 O(degree)** |
| **低** | ~~Patch 冲突处理粗糙~~ | ~~仅字符串完全匹配，无三路合并~~ | ~~`src/core/patch.ts`~~ | ✅ **已解决 — 精确匹配 → 模糊 substring 匹配** |
| **低** | ~~知识图谱节点删除后未清理孤儿边~~ | ~~可能残留无效边~~ | ~~`src/core/knowledge-graph.ts`~~ | ✅ **已解决 — removeNode 自动调用 removeEdgesByNode** |
| **低** | ~~`estimateTokens` 启发式粗糙（text.length / 4）~~ | ~~所有模型一刀切估算~~ | ~~`src/core/token-budget.ts`~~ | ✅ **已解决 — ModelAwareTokenEstimator（支持国产模型 + 中文自适应）** |

---

## 6. 下一步建议

### 6.1 已完成 ✅

1. **Tree-sitter 集成** — `fingerprint.ts` AST 解析替代正则
2. **`code-agent sync`** — 增量同步命令已实现
3. **LLM 增强 Agent** — FaultDetector + SolutionPlanner 集成 LLM
4. **Anthropic API 接入** — `AnthropicLlmService` + `--llm` CLI 选项
5. **AgentInput 类型安全** — Zod Schema + `parseContext` 验证
6. **知识图谱索引优化** — 邻居查询从 O(n²) 优化到 O(degree)
7. **故障传播分析引擎** — `PropagationEngine` + `ContextBuilderAgent` 集成
8. **Token 预算控制** — `TokenBudgetManager` + 四级降级 + CLI `--budget`
9. **模型感知 Token 估算** — `ModelAwareTokenEstimator`（国产模型 + 中文自适应）
10. **安全多 Provider 配置** — `LlmConfigResolver` + API key 脱敏 + 环境变量/用户配置分层
11. **技术债清空** — `signaturesEqual` 深度比较 + Patch 模糊匹配 + 孤儿边清理
12. **联网搜索模块** — `WebSearchEngine` + 4 种查询模板 + 模拟 provider
13. **WebSearcherAgent** — 集成到 `plan()` 流程 + 记忆缓存
14. **LLM generatePatch** — `TemplateLlmService` / `AnthropicLlmService` / `HttpLlmService` 全部实现
15. **PatchGeneratorAgent LLM 增强** — 缺失代码时自动调用 LLM 生成 diff
16. **CLI `--web-search`** — 默认启用，支持 `--no-web-search` 禁用
17. **Git 自动化** — `GitExecutor` + `GitExecutorAgent`，分支创建/提交/推送
18. **Git 安全策略** — 禁止直接修改 protected branch，自动创建 feature 分支
19. **TokenBudget 跨会话持久化** — `TokenBudgetManager` 状态接入 `MemoryMiddleware` L2
20. **Git SafetyNet** — Pre-commit 自动检查（syntax/test/lint/diff size/file count）
21. **Plan 持久化与 apply 命令** — `.repair-agent/plans/` 存储 + `code-agent apply <plan-id>` 完整实现
22. **CLI 版本号同步** — `0.1.0` → `0.4.0`
23. **`RootCauseAnalyzerAgent` 独立化** — 根因分析从 `SolutionPlannerAgent` 抽离为独立 Agent，职责分离
24. **`LlmService.analyzeRootCause`** — 全 Provider 支持（Template/Anthropic/HTTP）
25. **GitHub Actions CI** — `.github/workflows/ci.yml`，Node 20/22 矩阵，测试 + 构建
26. **`code-agent batch`** — 批量任务处理（JSON 任务列表，顺序/并行模式，autoPush 支持）
27. **package.json 版本同步** — `0.2.0` → `0.4.0`
28. **搜索降级集成** — `plan()` 集成 `TokenBudgetManager` 的 `enableWebSearch` 建议
29. **Batch 并行分析** — `FaultDetectorAgent` 文件级分析改为 `Promise.all` 并行
30. **结果缓存** — `ResultCache` 模块：指纹哈希键缓存分析结果
31. **语义缓存** — `SemanticCache` 模块：Jaccard 关键词相似度复用历史 plan
32. **上下文压缩** — `ContextCompressor` 模块：大文件结构摘要，节省 50-70% token
33. **L3 LearnedMemory 扩展** — `Convention` 类型 + `recordTask`/`addFaultPattern`/`addFixPattern`/`addConvention` 方法
34. **模式提取引擎** — `PatternExtractor`：从 findings/plans 提取 fault/fix 模式，关键词聚类归一化
35. **约定学习引擎** — `ConventionLearner`：从代码指纹学习命名(camelCase/PascalCase)/测试/架构约定
36. **推荐引擎** — `RecommendationEngine`：Jaccard 相似度评分，任务-模式匹配排序
37. **学习 Agent** — `LearningAgent`：协调学习流程，自动记录任务，提取模式，生成推荐
38. **`code-agent history`** — 查看任务历史、故障模式、项目约定
39. **`code-agent learn`** — 从代码库自动学习项目约定并持久化
40. **任务自动记录** — `plan()`/`fix()` 成功后自动记录到 L3 LearnedMemory
41. **CI/CD 发布流程** — GitHub Actions `release.yml` + npm 自动发布 + provenance + `prepublishOnly` 钩子
42. **Tree-sitter Go/Java 扩展** — `extractGo()` + `extractJava()`，支持函数/类/导入/导出提取
43. **全局 Metrics 框架** — `MetricsCollector`：Agent 性能 + Token 追踪 + 缓存命中率 + 解析器覆盖率 + 图谱规模 + 增量节省
44. **`code-agent metrics` 命令** — 终端展示所有性能指标，支持 `--json` 和 `--reset`
45. **Tavily Web Search** — `@tavily/core` 替换 DuckDuckGo，keyless mode + API key 支持，DuckDuckGo 降级链保留
46. **核心修复 API 上提** — `CodeRepairAgent.applyPlan/apply/repair` 统一 patch→review→apply→git→record 编排（DESIGN §6.2），CLI fix/apply/batch 去重；交互式 review 改为注入回调
47. **语义缓存跨进程持久化** — `SemanticCache` entries 序列化进 `memory.json`（export/load + 200 条上限淘汰），CLI 跨命令命中生效；缓存命中也记录 metrics
48. **LLM 补丁生成接通** — `applyPlan` 向 `PatchGeneratorAgent` 注入 `llmService`，方案缺代码时可调用 LLM 生成 diff（原先不可达）
49. **主语言自动探测** — `detectPrimaryLanguage()` 从指纹/目标文件扩展名推断，替换 web search 写死的 `language: 'typescript'`
50. **metrics 定时器 `unref()`** — 修复所有成功 CLI 命令结束后进程悬挂的预存 bug；`fix` 与 `apply` 的 git 失败退出码统一
51. **跨文件 `calls`/`inherits` 边构建** — 新增共享 `src/core/graph-build.ts`：指纹提取函数调用点（`FunctionSignature.calls`）与父类（`ClassSignature.superClass`），构建 function→function 调用边和 class→superclass 继承边（同文件 + 经相对 import 跨文件解析）；`init` 与 `sync` 统一走该模块，传播引擎已有规则现可实际触达跨文件调用链
52. **符号级 import 解析** — 相对 import 解析到具体导出符号节点（`function:file:foo` / `class:file:Bar`）而非粗粒度 `module:` 节点；外部包仍保留 `module:` 节点（此前为悬空边，现为真实节点可参与传播）
53. **`propagationResult` 接入根因分析** — `ContextBuilderAgent` 返回完整 `propagationResult`（affectedNodes + rootCauseCandidates），`plan()` 捕获并传给 `RootCauseAnalyzerAgent`（此前丢弃，根因传播洞察恒为空）
54. **预算降级 → 传播深度联动** — `plan()` 将 `TokenBudget` 的 `maxPropagationDepth` 注入 `ContextBuilder`（经 schema 校验，支持 0 深度=不传播），不再写死默认 3
55. **修复 import 提取预存 bug** — `import_clause` 是子节点而非命名字段，`childForFieldName` 恒返回 null 导致 named/default import 的 `items` 始终为空（此前无测试覆盖）；改为按子节点类型查找，default import 取 `.text` 而非节点对象。此 bug 此前使 #51/#52 的跨文件解析在运行时失效
56. **PR 自动创建** — `GitExecutor.createPullRequest`：优先 `gh pr create`（带 title/body/base/head），`gh` 不可用或失败时降级为手动 compare URL；新增纯函数 `parseRemoteUrl`（SSH/HTTPS/自托管）+ `buildCompareUrl`，`execute()` 在 push 后按 `push.createPR` 触发（protected 分支自动跳过）；`prUrl` 经 GitExecutorAgent → `RepairOutcome.git` 贯通至 CLI 输出；`code-agent fix --create-pr` 标志接入。关闭 Phase 4 最后实质缺口
57. **知识图谱 A 层语义增强（GraphEnricher 管线）** — 新增 `src/core/graph-enrich.ts`：可插拔、按层（A/B/C/D）开关的 `GraphEnricher` 管线，挂在 `buildGraphFromFingerprints` 确定性内核之后（`init` 与 `sync` 统一接入，单一真相源）。落地全部 A 层（零 token 静态）：① `implements` 边——指纹新增 `ClassSignature.implements`（Tree-sitter 提取 `implements` 子句），enricher 按 inherits 同构解析（同文件 + 跨 import）；② `tested_by` 边——测试文件命名/路径识别 + 相对 import 解析到源文件；③ `depends_on` 边——文件级 import 聚合（相对→file、外部→module）；④ 文件分类器节点——`config`/`document`/`pipeline`/`service`/`schema`，扫描器新增 `assetFiles` 采集非源文件（`.repair-agent` 加入忽略目录）。真实仓库 `init` 端到端验证：6 类新节点/边全部正确构建。详见 `docs/GRAPH-ENRICHMENT-PLAN.md`
58. **知识图谱 B 层语义增强（框架感知静态，零 token）** — 完整落地 B 层全部 4 类模式提取(`graph-enrich.ts` 新增 5 个 enricher)。因指纹只记 callee 名不含参数,B 层经 `EnrichContext.sources` 读源码做保守模式匹配;扫描器新增 `sources` 采集(源文件 + `.prisma`/`.sql` schema 文件内容)。① `endpoint` 节点 + `routes` 边——调用式(`app.get('/path')`,路径须以 `/` 开头以排除 `map.get('key')`)+ 装饰器式(`@Get('/path')`);② `subscribes`/`publishes` 边——`.on/.emit` 等带字符串事件名,连到共享 `concept:event:<name>` 节点;③ `middleware` 边——`app/router/server/api.use(ident)` 且实参为可解析到函数节点的裸标识符(排除 `React.use`/内联调用);④ `reads_from`/`writes_to` 边——`fs.*` 读写 + `*.query(` 连到 `resource:filesystem`/`resource:database`;⑤ `table` 节点 + `defines_schema` 边——Prisma `model` 块 + SQL `CREATE TABLE`,连到 A 层 `schema:` 节点。`init`/`sync` 启用 `['A','B']`。真实仓库端到端验证:7 类新边 + endpoint/table/resource/concept 节点全部正确构建,B 接 A 的 schema 节点无悬空
59. **知识图谱 C 层语义增强（Embedding 相似度,零 token,桩接通）** — 落地 C 层全部算法 + 缓存 + 接线（详细设计见 `docs/GRAPH-ENRICHMENT-PLAN.md` §7）。**[#5 已在 #60 完成,本条为桩阶段历史记录]**。① `EmbeddingService` 抽象（`src/core/embedding-service.ts`）镜像 `LlmService`/`LlmConfigResolver` 三 Provider 模式：`TemplateEmbeddingService`（char-trigram 哈希桩,零依赖,确定性,相同文本 cos=1）、`LocalEmbeddingService`（ONNX,默认 `bge-small-en-v1.5`,#5 实装,当前 `createEmbeddingService` 显式 warn 降级桩）、`ApiEmbeddingService`（可选）；`EmbeddingConfigResolver` 分层解析 + 别名。② `embeddingsEnricher`（layer C）：按 §7.2 从指纹构造 function/class/file 节点文本,**同类型内**余弦分带（`≥0.85→similar_to`、`[0.70,0.85)→related`,weight=cos）+ 每节点 top-K=5 + canonical 方向去重；O(n²) 护栏（`>2000→warn+跳过`,no-silent-caps）。③ `clusterEnricher`（layer C）：**跨类型** pool 全部嵌入节点,union-find 连通分量（cos≥0.80,size≥2）产**匿名** `concept:cluster:<sha8>` 节点（命名留 D 层 `rename`,占位名=成员公共 token）+ 成员 `related` 边。④ `EmbeddingCache` + `CachedEmbeddingService` 装饰器：键 = `<model>:<dim>:<textHash>`,LRU + memory.json 持久化（`MemoryMiddleware.get/setEmbeddingCache` + serialize）;按文本哈希键三重收益——消除 #2/#3 重复嵌入（cluster 第二趟零 provider 调用）、sync 未变文件自动命中、模型切换自动失效。⑤ 接线：`init`/`syncRepo` 在 provider 配置时启用 `['A','B','C']` 并注入 cache-backed embeddings + 持久化回写;CLI `init`/`sync` 新增 `--embeddings [provider]`（默认关闭,缺省 provider=template）。真实仓库端到端验证：similar_to/related/concept 节点入图、embeddingCache 持久化到 memory.json、sync 跨进程缓存命中、cluster 第二趟零嵌入全部确认。**⚠️ 桩的"相似度"是词法重叠非语义,DoD 须 #5 真实模型 eval（§7.8）**

60. **知识图谱 C 层收尾（#5 真实 ONNX 模型 + DoD eval,C 层「真完成」）** — 落地 `LocalEmbeddingService`（`src/core/embedding-service.ts`）：经 **`@huggingface/transformers`（optional dep,懒加载）** 跑 ONNX,默认 `bge-small-en-v1.5`（q8 量化,384 维,~34MB）,mean-pool + L2 归一化,与 C 层管线全模型无关对接。① `createEmbeddingService` 的 `local` 分支从「warn 降级桩」改为返回真 `LocalEmbeddingService`（构造零成本,模型懒加载于首次 `embed()`,memoized）;`api` 仍降级桩并 warn（no-silent-caps）。② optional dep + 变量化动态 import（`const TRANSFORMERS_MODULE: string`）——native onnxruntime 装失败不阻断构建/测试,缺包时首次 embed 抛可执行的安装提示。③ 离线/受限网络支持：`EMBEDDING_MODEL_PATH`（本地模型目录)/`HF_ENDPOINT`（镜像主机)/`EMBEDDING_DTYPE` 经 `EmbeddingConfigResolver` 贯通;`scripts/fetch-embedding-model.sh` 默认走 `hf-mirror.com` 预下载到 `./models`（`.gitignore: models/`,不入 git）。④ **DoD eval（§7.8,可复现）**：`scripts/eval-embeddings.mjs` 真实模型 vs 桩 side-by-side——真实模型对**语义相关但词法不同**的签名对正确分带（`authenticate~login` **0.878/similar_to**、`HttpClient~ApiRequester` **0.703/related**、`deleteFile~removeDocument` **0.754/related**),桩全部漏判（0.571/0.349/0.582 → 无边）;无关对两者皆「—」。`tests/embedding-service.test.ts` 新增构造测试 + `describe.skipIf` 守卫的真实模型 DoD 用例（模型存在自动启用,缺失则跳过不静默通过）。⑤ 真实仓库 `init --embeddings local` 端到端：`authenticate→login` 产 `related` 边（w=0.834,桩在同对不产边）、跨类型 `concept:cluster` 成形、embeddingCache 持久化、`sync` 未变文件零嵌入（全缓存命中）。**C 层至此非桩全绿冒充——真实模型语义可用经人验证（详见 `docs/GRAPH-ENRICHMENT-PLAN.md` §7.8/§7.9）。**

61. **知识图谱 D 层语义增强（LLM,默认关闭）** — 落地 D 层全部 enricher 与接线（详见 `docs/D-LAYER-IMPLEMENTATION.md`）。① 扩展 `LlmService` 接口 + Template/Anthropic/Http 三 Provider 实现：新增 `summarizeNode`、`nameConceptCluster`、`classifyArchitectureLayer`、`detectSemanticEdges` 四个语义方法；Template 给确定性占位输出，Anthropic 给真实 prompt，Http 当前 fallback 到 template（callApi 尚未实现）。② 新增 `src/core/llm-semantic-cache.ts` + `MemoryMiddleware` 持久化字段：按 `<enricher>:<nodeId/clusterId>:<contentHash>` 缓存，跨 `init/sync` 复用，避免未变文件重复调用 LLM。③ 4 个 D 层 enricher：`summaryEnricher`（function/class/file 节点 summary/tags）、`conceptNamingEnricher`（重命名 C 层匿名 `concept:cluster:*`）、`architectureLayerEnricher`（创建 `concept:layer:*` 节点并与文件连 `related` 边）、`semanticEdgeEnricher`（识别 `transforms`/`validates` 函数间语义边）。④ `KnowledgeGraphBuilder.updateNode` 支持 D 层更新现有节点。⑤ CLI `init`/`sync` 新增 `--semantic` 选项，`AgentConfig.semanticEnrichment` 默认 `false`，仅在显式开启时运行 D 层。⑥ 测试：`tests/graph-enrich-d.test.ts`（7 例）、`tests/llm-semantic-cache.test.ts`（5 例）、`tests/cli.test.ts` D 层集成断言；`scripts/eval-d-layer.mjs` 供真实 API key 下人工 review。**⑦ 修复 semantic edges 截断问题**：`semanticEdgeEnricher` 改为基于 `calls` 边生成双向候选对，按候选对分批调用 `detectSemanticEdges`（每批最多 15 函数 / 25 对），body 片段缩至 300，`max_tokens` 动态计算；`extractJson` 增加截断容错，可关闭未闭合字符串与数组/对象。**⑧ 真实 API DoD 验证通过**：`npx tsx src/index.ts init --semantic --embeddings local /Users/apple/code-agent` 成功跑完，产出 `transforms` 33 条、`validates` 2 条，无 `detectSemanticEdges failed` 日志。D 层 DoD 全部达成。

### 6.2 剩余重要工作（按优先级）

| 优先级 | 任务 | 说明 | 阶段 |
|--------|------|------|------|
| 🟡 中 | **~~联网搜索模块~~** | ~~Web Search API 接入~~ | ✅ **已完成 — 模拟 provider + CLI 集成** |
| 🟡 中 | **~~Patch 生成器增强~~** | ~~LLM 生成可执行代码 diff~~ | ✅ **已完成 — 全 Provider 支持** |
| 🟢 低 | **~~真实 Web Search API~~** | ~~接入 Google/Bing 等真实搜索 API~~ | ✅ **已完成 — DuckDuckGo（无需 API key）** |
| 🟢 低 | **~~Git 自动化~~** | ~~分支/提交/推送/PR 创建~~ | ✅ **已完成 — GitExecutor + SafetyNet + 安全分支策略** |
| 🟢 低 | **Plan 持久化** | `code-agent apply <plan-id>` 完整实现 | ✅ **已完成 — plan 保存/加载/应用闭环** |
| 🟢 低 | **CI/CD 发布流程** | GitHub Actions CI + 自动发布到 npm | ✅ **已完成 — tag 触发 + provenance + prepublishOnly** |
| 🟢 低 | **Tree-sitter Go/Java** | AST 精确解析扩展 | ✅ **已完成 — extractGo + extractJava** |
| 🟢 低 | **全局 Metrics 框架** | Agent/Token/Cache/Parser/Graph 指标收集 | ✅ **已完成 — MetricsCollector + code-agent metrics CLI** |
| 🟢 低 | **学习进化** | 历史任务模式提取 | Phase 5 |
| 🟢 低 | **Tavily Web Search** | 替换 DuckDuckGo 为 Tavily + 降级链 | ✅ **已完成 — `@tavily/core` + keyless + DuckDuckGo fallback** |

### 6.3 技术债

**历史技术债：全部清空 ✅；新增 1 项可扩展性债（已记录，低优先级）**

| 优先级 | 问题 | 位置 | 状态 |
|--------|------|------|------|
| 🟡 中 | **C 层相似度/聚类在节点组 > 2000 时整组跳过** — 成对余弦为 O(n²)，超 `MAX_GROUP_SIZE=2000` 时 `embeddingsEnricher`/`clusterEnricher` 跳过该组（有 `logger.warn`，非静默截断）。大仓库（单类型节点 >2000）C 层零产出。**待分桶降级（bucketed top-K / LSH 近邻）实现** | `src/core/graph-enrich.ts:467,548,693` | ⏳ 待实现（出现大仓库需求时） |
| 低 | ~~`signaturesEqual` 用 `JSON.stringify` 比较~~ | ~~`src/core/fingerprint.ts`~~ | ✅ 已解决 |
| 低 | ~~Patch 冲突处理粗糙~~ | ~~`src/core/patch.ts`~~ | ✅ 已解决 |
| 低 | ~~知识图谱节点删除后可能残留孤儿边~~ | ~~`src/core/knowledge-graph.ts`~~ | ✅ 已解决 |
| 低 | ~~`estimateTokens` 启发式粗糙~~ | ~~`src/core/token-budget.ts`~~ | ✅ 已解决 |

### 6.4 可优化方向（已评估策略，待数据验证后执行）

> 以下方向已完成技术评估和 ROI 分析，建议在实际运行中收集指标后再决定是否实施。

#### 方向 A：Tree-sitter 语言扩展

**现状**：当前 Tree-sitter 精确解析覆盖 **6 种语言**（TS/TSX/JS/JSX/Python/Go/Java），其余 16 种语言使用正则回退。

**评估结论**：

| 语言 | 复杂度 | 实际工时 | 状态 |
|------|--------|---------|------|
| **Go** | ⭐ 低 | ~2h | ✅ **已完成** — `extractGo()` 支持函数/struct/方法/导入/导出 |
| **Java** | ⭐ 低 | ~3h | ✅ **已完成** — `extractJava()` 支持类/接口/方法/字段/导入 |
| **PHP** | ⭐⭐ 中 | 4-6h | 🟡 按需 — namespace + use 导入系统 |
| **C#** | ⭐⭐ 中 | 4-6h | 🟡 按需 — property/accessor 需额外处理 |
| **Ruby** | ⭐⭐ 中 | 5-8h | 🟡 按需 — 动态性强，无显式返回类型 |
| **Rust** | ⭐⭐⭐ 高 | 8-16h | 🔴 推迟 — trait/impl/macro/lifetime 复杂；建议先做函数签名简化版 (~4h) |
| **C/C++** | ⭐⭐⭐ 高 | 8-16h | 🔴 不建议 — 头文件系统与 tree-sitter 单文件模型冲突，建议保持正则或集成 libclang |

**执行策略**：Go + Java 已完成并验证（213 测试通过）。运行一段时间评估价值后再决定是否扩展至 PHP/C#/Ruby。

#### 方向 B：SemanticCache 准确度升级

**现状**：`SemanticCache` 使用 Jaccard 关键词相似度，零 token 消耗，但无法理解同义词，中文支持差。

**Metrics 数据收集已就绪 ✅**：`MetricsCollector` 已集成到 `SemanticCache`，自动记录每次查询的命中率、最佳相似度分数和分布统计。运行 `code-agent metrics` 即可查看。

**渐进式升级路径**（建议按此顺序执行）：

```
Phase 1（现在）: 保持 Jaccard + 运行收集数据
  └── MetricsCollector 自动记录 cache hit/miss/similarityScore
      运行 2-4 周后评估命中率

Phase 2（命中率 < 50% 时）: 本地轻量 Embedding
  └── 集成 all-MiniLM-L6-v2 via ONNX Runtime
      零 token 消耗，准确度提升到 85%+
      包体积增加 ~50MB（或 wasm 版本 ~20MB）

Phase 3（团队/高频场景）: 混合策略
  └── Jaccard 快速过滤 Top-5 → API Embedding 精排 Top-1
      仅在高频使用且 API key 可用环境启用
```

**ROI 决策公式**：

```
升级价值 = (命中率提升 × 单次 plan() 节省 token) - (升级后每查询消耗 token)

示例：Jaccard 70% → Embedding 90%，plan() 消耗 ~10,000 tokens
      每次命中节省 = 10,000 × 20% = 2,000 tokens
      每查询 Embedding 成本 = 500 tokens
      净收益 = +1,500 tokens/查询 ✅
```

**结论**：若实际命中率验证在 70% 以下，升级 Embedding 是正向 ROI；若已在 70% 以上，保持 Jaccard 是最优解。

---

## 7. 文件清单

### 源代码（40 个文件）

```
src/
├── index.ts                      ~1330 行  (CLI 入口 + 主类 + metrics CLI + **D 层接线**)
├── core/
│   ├── types.ts                  600 行  (核心类型 + D 层结果类型)
│   ├── fingerprint.ts            ~1000 行  (Tree-sitter 指纹计算 + Go/Java)
│   ├── knowledge-graph.ts        231 行  (知识图谱构建器 + updateNode)
│   ├── memory.ts                 282 行  (记忆层 + D 层缓存)
│   ├── repo-scanner.ts            96 行  (扫描器)
│   ├── patch.ts                   82 行  (Patch 数据结构)
│   ├── sync.ts                   254 行  (增量同步 + D 层接线)
│   ├── llm-service.ts            ~1190 行  (LLM 服务抽象 + 多 Provider + **D 层语义方法**)
│   ├── propagation.ts            303 行  (故障传播引擎)
│   ├── token-budget.ts           170 行  (Token 预算管理器 + metrics 集成)
│   ├── token-estimator.ts        100 行  (模型感知 Token 估算)
│   ├── llm-config.ts             180 行  (LLM 配置 + API key 安全)
│   ├── web-search.ts             180 行  (Web 搜索引擎 + Tavily + DuckDuckGo 降级)
│   ├── git-executor.ts           200 行  (Git 操作封装 + 安全策略)
│   ├── semantic-cache.ts         103 行  (语义缓存 + metrics 集成)
│   ├── metrics.ts                ~220 行  (MetricsCollector — 全局指标)
│   ├── graph-build.ts            219 行  (确定性图谱内核：跨文件 calls/inherits + 符号级 import)
│   ├── graph-enrich.ts           928 行  (GraphEnricher 管线：A/B/C/D 层 enricher)  ✅ **D 层新增**
│   ├── graph-writer.ts           197 行  (fault/fix/pattern 节点写入图谱)
│   ├── llm-semantic-cache.ts      39 行  (D 层 LLM 结果缓存)
│   ├── embedding-service.ts      511 行  (EmbeddingService 抽象 + LocalEmbeddingService(ONNX) + EmbeddingCache + 装饰器)
│   ├── context-compressor.ts     100 行  (上下文压缩：大文件结构摘要)
│   ├── result-cache.ts           117 行  (结果缓存：指纹哈希键)
│   ├── pattern-extractor.ts      122 行  (模式提取：fault/fix 模式)
│   ├── convention-learner.ts     102 行  (约定学习：命名/测试/架构)
│   └── recommendation-engine.ts  100 行  (推荐引擎：任务-模式相似度)
├── agents/
│   ├── base-agent.ts              47 行  (Agent 基类 + metrics 集成)
│   ├── patch-generator-agent.ts   75 行  (Patch 生成 + LLM 增强)
│   ├── solution-planner-agent.ts  85 行  (LLM 增强方案规划 + 搜索集成)
│   ├── fault-detector-agent.ts    96 行  (LLM 增强故障检测)
│   ├── repo-scanner-agent.ts      39 行  (扫描 Agent)
│   ├── context-builder-agent.ts   55 行  (上下文构建 + 传播集成)
│   ├── web-searcher-agent.ts      65 行  (Web 搜索 Agent)
│   ├── git-executor-agent.ts      35 行  (Git 执行 Agent)
│   ├── root-cause-analyzer-agent.ts 145 行  (根因分析 Agent)
│   └── learning-agent.ts         118 行  (学习 Agent + pattern 入图)
├── interface/
│   └── cli-review.ts              61 行  (Review UI)
└── utils/
    ├── logger.ts                  36 行  (日志)
    └── hash.ts                     5 行  (哈希)

总计: ~11,000 行代码 + **354** 个测试（**39** 个测试文件）
```

---

*本文档随项目进展持续更新。*
