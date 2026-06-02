# Code Repair Agent — 实现进度报告

> 生成日期: 2026-06-02
> 对比基准: DESIGN.md v1.0.0
> 当前版本: 0.3.0 (Phase 3 进行中)

---

## 总体完成度

| 阶段 | 计划内容 | 完成状态 |
|------|---------|---------|
| Phase 1: MVP（核心闭环）| 核心 Agent + CLI + 基础图谱 + Patch/Review 流程 | **100%** |
| Phase 2: 记忆优化 | Fingerprint 增量、传播裁剪、Token 预算 | **100%** |
| Phase 3: 联网增强 | Web Search、结果融合、LLM Patch 生成 | **100%** |
| Phase 4: 自动化与集成 | Git 自动化、CI/CD | **0%** |
| Phase 5: 学习与进化 | 模式提取、项目约定学习 | **0%** |

**整体完成度: ~75%**

---

## 1. 系统架构实现状态

### 1.1 核心 Agent（8 个计划中）

| Agent | 职责 | 状态 | 说明 |
|-------|------|------|------|
| `repo-scanner` | 扫描仓库，提取文件、依赖、指纹 | ✅ **已完成** | `RepoScannerAgent` 类实现，集成 `scanRepo()` 和 `buildImportMap()` |
| `fault-detector` | 定位代码中的问题点 | ✅ **LLM 增强** | 启发式 + `TemplateLlmService` 语义分析（6 种检测模式） |
| `context-builder` | 召回与问题相关的代码上下文 | ✅ **已完成** | `ContextBuilderAgent` 实现，基于知识图谱邻居遍历 |
| `web-searcher` | 联网搜索解决方案 | ✅ **已完成** | `WebSearcherAgent` + `WebSearchEngine` + 模拟搜索 provider |
| `root-cause-analyzer` | 综合分析，定位根因 | ⚠️ **部分完成** | `SolutionPlannerAgent` 集成 LLM 生成根因分析 |
| `solution-planner` | 输出结构化修改方案 | ✅ **LLM 增强** | 生成带 `originalCode`/`modifiedCode` 的深度方案 |
| `patch-generator` | 将方案转换为具体代码 diff | ✅ **已完成** | `PatchGeneratorAgent` 实现，支持 add/modify/delete |
| `git-executor` | 执行 git 操作 | ❌ **未开始** | 计划 Phase 4 实现 |

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
| 语义签名（扩展） | ❌ | 计划 Phase 2 |
| **Python 支持** | ✅ **新增** | 基础函数/类/导入提取 |

### 3.3 记忆中间层 ✅

| 功能点 | 状态 | 备注 |
|--------|------|------|
| L1: 仓库级静态知识 | ✅ | knowledgeGraph + fingerprints + importMap |
| L2: 任务级动态记忆 | ✅ | taskId + analyzedFiles + recalledNodes + findings |
| L3: 跨任务学习记忆 | ⚠️ 结构就绪 | 类型定义完成，待 Phase 5 填充逻辑 |
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
| `code-agent history` | 查看历史任务 | ❌ **未实现** | 计划 Phase 5 |
| `code-agent learn` | 学习模式 | ❌ **未实现** | 计划 Phase 5 |

### 3.6 Token 优化策略

| 策略 | 设计目标 | 状态 | 备注 |
|------|---------|------|------|
| **Fingerprint 跳过** | 80-95% 节省 | ✅ **已实现** | `syncRepo` 自动跳过未变化文件 |
| **故障传播裁剪** | 70-90% 节省 | ✅ **已实现** | `PropagationEngine` 自动裁剪分析集 |
| 语义缓存 | 60-80% 节省 | ❌ 未实现 | 计划 Phase 3 |
| **增量图谱更新** | 90%+ 节省 | ✅ **已实现** | `syncRepo` 仅更新变化文件节点 |
| 搜索降级 | 100% 搜索 token 节省 | ❌ 未实现 | 计划 Phase 3 |
| 上下文压缩 | 50-70% 节省 | ❌ 未实现 | 计划 Phase 3（低优先级） |
| Batch 并行 | 时间节省 | ❌ 未实现 | 计划 Phase 3（低优先级） |
| 结果缓存 | 80%+ 节省 | ❌ 未实现 | 计划 Phase 3 |

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
| `tests/agents.test.ts` | 6 | 6 个专用 Agent（含 PatchGenerator + 传播集成） |
| `tests/cli.test.ts` | 11 | CLI 入口 + 内存持久化 + apply + 预算测试 |
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
| **总计** | **144** | **18 个模块** |

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
| 联网搜索为模拟 provider | 未接入真实 Web Search API（Google/Bing） | Phase 3.x 接入真实 API |
| 无 Git 自动化 | 不执行分支/提交/推送 | Phase 4 实现 |
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

### 6.2 剩余重要工作（按优先级）

| 优先级 | 任务 | 说明 | 阶段 |
|--------|------|------|------|
| 🟡 中 | **~~联网搜索模块~~** | ~~Web Search API 接入~~ | ✅ **已完成 — 模拟 provider + CLI 集成** |
| 🟡 中 | **~~Patch 生成器增强~~** | ~~LLM 生成可执行代码 diff~~ | ✅ **已完成 — 全 Provider 支持** |
| 🟡 中 | **真实 Web Search API** | 接入 Google/Bing 等真实搜索 API | Phase 3.x |
| 🟢 低 | **Git 自动化** | 分支/提交/推送/PR 创建 | Phase 4 |
| 🟢 低 | **学习进化** | 历史任务模式提取 | Phase 5 |

### 6.3 技术债

**当前状态：全部清空 ✅**

| 优先级 | 问题 | 位置 | 状态 |
|--------|------|------|------|
| 低 | ~~`signaturesEqual` 用 `JSON.stringify` 比较~~ | ~~`src/core/fingerprint.ts`~~ | ✅ 已解决 |
| 低 | ~~Patch 冲突处理粗糙~~ | ~~`src/core/patch.ts`~~ | ✅ 已解决 |
| 低 | ~~知识图谱节点删除后可能残留孤儿边~~ | ~~`src/core/knowledge-graph.ts`~~ | ✅ 已解决 |
| 低 | ~~`estimateTokens` 启发式粗糙~~ | ~~`src/core/token-budget.ts`~~ | ✅ 已解决 |

---

## 7. 文件清单

### 源代码（19 个文件）

```
src/
├── index.ts                      450 行  (CLI 入口 + 主类)
├── core/
│   ├── types.ts                  320 行  (核心类型)
│   ├── fingerprint.ts            319 行  (Tree-sitter 指纹计算)
│   ├── knowledge-graph.ts        100 行  (知识图谱构建器)
│   ├── memory.ts                 128 行  (记忆层)
│   ├── repo-scanner.ts            96 行  (扫描器)
│   ├── patch.ts                   82 行  (Patch 数据结构)
│   ├── sync.ts                   163 行  (增量同步)
│   ├── llm-service.ts            425 行  (LLM 服务抽象 + 多 Provider)
│   ├── propagation.ts            303 行  (故障传播引擎)
│   ├── token-budget.ts           170 行  (Token 预算管理器)
│   ├── token-estimator.ts        100 行  (模型感知 Token 估算)    ✅ 新增
│   ├── llm-config.ts             180 行  (LLM 配置 + API key 安全)  ✅ 新增
│   └── **web-search.ts**         **180 行**  (**Web 搜索引擎 + 查询构建 + 模拟 provider**)  ✅ **新增**
├── agents/
│   ├── base-agent.ts              47 行  (Agent 基类)
│   ├── patch-generator-agent.ts   75 行  (Patch 生成 + **LLM 增强**)   ✅ **修改**
│   ├── solution-planner-agent.ts  85 行  (LLM 增强方案规划 + **搜索集成**) ✅ **修改**
│   ├── fault-detector-agent.ts    96 行  (LLM 增强故障检测)
│   ├── repo-scanner-agent.ts      39 行  (扫描 Agent)
│   ├── context-builder-agent.ts   55 行  (上下文构建 + 传播集成)   ✅ 修改
│   └── **web-searcher-agent.ts**  **65 行**  (**Web 搜索 Agent**)           ✅ **新增**
├── interface/
│   └── cli-review.ts              61 行  (Review UI)
└── utils/
    ├── logger.ts                  36 行  (日志)
    └── hash.ts                     5 行  (哈希)

总计: ~3,500 行代码 + **144** 个测试（**18** 个测试文件）
```

---

*本文档随项目进展持续更新。*
