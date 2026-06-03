# Code Repair Agent — 技术规划方案

> 实施层面技术规划，指导从设计到代码的落地过程
> 版本: v1.0.0
> 日期: 2026-05-29
>
> **Update (2026-06-02)**: 部分选型在实施中调整，详见备注。
> - LLM 调用：未引入 Vercel AI SDK，改用各 Provider 原生 SDK + 通用 HttpLlmService
> - 其余选型（commander / tree-sitter / zod / vitest）按规划落地

---

## 1. 技术选型确认

### 1.1 总体策略

采用**核心手写 + 关键依赖**的轻量架构，不引入重型 Agent 框架。

| 层级 | 策略 | 理由 |
|------|------|------|
| Agent 编排 | **手写顺序编排**（`index.ts` 中直接调用） | 项目自定义机制（Fingerprint、传播裁剪、Token 预算）与框架抽象冲突；独立 `PipelineRunner` 延后到 Phase 4 |
| LLM 调用 | **各 Provider 原生 SDK + 通用 `HttpLlmService`** | 未引入 Vercel AI SDK；`AnthropicLlmService` 用 `@anthropic-ai/sdk`，`HttpLlmService` 覆盖 OpenAI 兼容 API（OpenAI/Moonshot/DeepSeek/Zhipu） |
| 类型校验 | **Zod** | 运行时校验 + TypeScript 类型推导一体化 |
| CLI 框架 | **commander**（已引入） | 成熟的 Node.js CLI 框架 |
| 代码解析 | **tree-sitter**（已引入） | 已落地，支持 TypeScript/TSX/JavaScript/JSX/Python |
| 本地搜索 | **fuse.js**（已引入） | 已确定，模糊搜索 |
| 测试框架 | **vitest**（已引入） | 已确定，与 UA 一致 |

### 1.2 新增依赖清单

```json
{
  "dependencies": {
    "ai": "^3.0.0",
    "zod": "^3.23.0"
  }
}
```

暂不引入：
- `langchain` / `@langchain/core` — 抽象过重，与自定义机制冲突
- `langgraph` — TS 版本成熟度不足
- `openai` SDK — `ai` SDK 已覆盖

---

## 2. 核心架构设计

### 2.1 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│                    交互层 (Interface)                         │
│  CLI (commander)  →  未来可扩展 Web / IDE Plugin              │
├─────────────────────────────────────────────────────────────┤
│                    编排层 (Orchestration)                     │
│  PipelineRunner  →  Phase 调度 / 并发控制 / 错误恢复            │
├─────────────────────────────────────────────────────────────┤
│                    Agent 层 (Agents)                          │
│  Markdown + YAML 定义  →  LLM 调用  →  结构化输出               │
├─────────────────────────────────────────────────────────────┤
│                    引擎层 (Engines)                           │
│  Fingerprint / Propagation / Search / Memory / Graph         │
├─────────────────────────────────────────────────────────────┤
│                    基础设施 (Infrastructure)                  │
│  LLM Client (ai SDK) / Tree-sitter / File System / Git      │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 关键设计原则

1. **Agent 即配置**：Agent 行为通过 Markdown + YAML 定义，运行时动态加载，代码只负责编排和 I/O
2. **状态外置**：Pipeline 状态持久化到磁盘，支持中断恢复（crucial for long-running analysis）
3. **零框架锁定**：任何依赖都应可在 1 天内替换（接口隔离）
4. **确定性优先**：静态分析能做的，绝不走 LLM

---

## 3. Agent 编排机制详细设计

### 3.1 Phase 流水线

固定 7 个 Phase，不可跳过，但内部可根据条件快速通过：

```
Phase 1: SCAN       ──▶ repo-scanner      ──▶ 文件发现 + 语言检测 + Import Map
Phase 2: DETECT     ──▶ fault-detector    ──▶ 故障定位（支持用户输入 + 自动规则）
Phase 3: PROPAGATE  ──▶ propagation-engine ──▶ 沿调用链传播分析，裁剪分析集
Phase 4: CONTEXT    ──▶ context-builder   ──▶ 召回相关代码 + 知识图谱节点
Phase 5: ANALYZE    ──▶ root-cause-analyzer ──▶ 综合分析，定位根因（条件触发 web-searcher）
Phase 6: PLAN       ──▶ solution-planner  ──▶ 生成结构化修改方案
Phase 7: OUTPUT     ──▶ patch-generator   ──▶ 生成 diff + Review 数据
```

### 3.2 PipelineRunner 核心职责

```typescript
// 伪接口，描述设计意图
interface PipelineRunner {
  // 执行完整流水线
  run(task: RepairTask, options?: RunOptions): Promise<PipelineResult>;

  // 从某个 Phase 恢复（支持中断恢复）
  resume(taskId: string, fromPhase: Phase): Promise<PipelineResult>;

  // 获取当前运行状态
  status(taskId: string): PipelineStatus;
}
```

**关键行为：**

| 行为 | 实现方式 |
|------|----------|
| Phase 内并行 | `Promise.all` + `p-limit`（限制并发数，默认 5） |
| Phase 间条件跳转 | 每个 Phase 返回 `PhaseResult`，Runner 根据 `result.decision` 决定下一 Phase |
| 错误恢复 | 每个 Phase 结束后保存快照到 `.repair-agent/task-memory/snapshots/` |
| 超时控制 | 每个 Phase 设置独立超时（默认 5min），超时后保存状态并抛出 |
| 取消支持 | 监听 `SIGINT`，保存当前状态后优雅退出 |

### 3.3 Phase 间数据契约

每个 Phase 的输入是上一个 Phase 的输出，通过强类型接口约束：

```typescript
// 示例：Phase 间传递的核心数据结构
type PhaseInput = {
  SCAN: { repoPath: string };
  DETECT: { fileManifest: FileManifest; importMap: ImportMap };
  PROPAGATE: { faults: FaultLocation[]; graph: KnowledgeGraph };
  CONTEXT: { affectedNodes: AffectedNode[]; propagationPaths: PropagationPath[] };
  ANALYZE: { context: CodeContext; searchResults?: SearchResult[] };
  PLAN: { rootCause: RootCauseAnalysis };
  OUTPUT: { solutionPlan: SolutionPlan };
};
```

---

## 4. LLM 调用层设计

### 4.1 统一客户端封装

基于 `ai` SDK 封装 `LLMClient`，隔离具体 provider：

```typescript
// 设计意图
interface LLMClient {
  // 普通文本生成
  generate(prompt: string, options?: GenerateOptions): Promise<string>;

  // 结构化对象生成（核心方法）
  generateObject<T extends z.ZodSchema>(
    prompt: string,
    schema: T,
    options?: GenerateOptions
  ): Promise<z.infer<T>>;

  // 流式生成（用于 Review 界面实时展示）
  stream(prompt: string, options?: GenerateOptions): AsyncIterable<string>;
}
```

**配置化 provider 切换：**

```yaml
# .repair-agent/config.yaml
llm:
  provider: anthropic  # 支持 anthropic / openai / google
  model: claude-sonnet-4-6
  maxTokens: 8192
  temperature: 0.2  # 低温度，减少幻觉
```

### 4.2 Agent 加载机制

Agent 定义存储为 `docs/agents/<agent-name>.md`，运行时读取解析：

```
docs/agents/
├── repo-scanner.md
├── fault-detector.md
├── root-cause-analyzer.md
├── solution-planner.md
├── patch-generator.md
└── ...
```

每个 Agent Markdown 文件结构：

```markdown
---
name: repo-scanner
model: claude-sonnet-4-6
maxTokens: 4096
temperature: 0.1
outputSchema: ScannerOutput  # 对应 Zod schema 名称
---

# Task
...Prompt 内容...

# Output Format
...输出格式说明...
```

**加载流程：**
1. 读取 Markdown 文件
2. 解析 YAML Frontmatter 为 `AgentConfig`
3. 提取 Markdown body 为 system prompt
4. 运行时注入用户输入 + 上文 Phase 输出作为 user prompt
5. 调用 `LLMClient.generateObject()` 获取结构化结果

---

## 5. 类型安全输出设计

### 5.1 Zod Schema 分层

所有 LLM 输出必须经 Zod 校验，Schema 按模块组织：

```
src/schemas/
├── common.ts          # 共享类型（CodeLocation、Severity 等）
├── scan.ts            # SCAN Phase 输出
├── fault.ts           # DETECT / PROPAGATE Phase 输出
├── analysis.ts        # ANALYZE Phase 输出
├── plan.ts            # PLAN Phase 输出
└── patch.ts           # OUTPUT Phase 输出
```

### 5.2 校验与降级策略

| 场景 | 策略 |
|------|------|
| Schema 校验通过 | 正常返回类型化对象 |
| Schema 校验失败（字段缺失） | 1. 记录原始输出到日志；2. 尝试用默认值填充；3. 重试一次（`temperature: 0`） |
| Schema 校验失败（类型错误） | 1. 记录日志；2. 抛出 `OutputValidationError`，Pipeline 进入人工介入状态 |
| 重试后仍失败 | 中断流水线，生成诊断报告供开发者调试 |

---

## 6. 状态管理与持久化

### 6.1 运行时状态

```typescript
interface PipelineState {
  taskId: string;
  currentPhase: Phase;
  completedPhases: Phase[];
  phaseResults: Record<Phase, PhaseResult>;
  tokenBudget: TokenBudget;       // 实时跟踪
  startedAt: string;
  updatedAt: string;
}
```

### 6.2 持久化策略

| 数据 | 存储位置 | 格式 | 持久化时机 |
|------|----------|------|----------|
| Pipeline 状态 | `.repair-agent/task-memory/snapshots/<taskId>.json` | JSON | 每个 Phase 结束后 |
| 知识图谱 | `.repair-agent/repo-memory/knowledge-graph.json` | JSON | 全量分析后 / 增量更新后 |
| 指纹库 | `.repair-agent/repo-memory/fingerprints.json` | JSON | 每次分析完成后（LOAD-PATCH-SAVE） |
| 任务历史 | `.repair-agent/task-memory/task-history.json` | JSON | 任务完成后 |
| 故障/修复模式 | `.repair-agent/task-memory/fault-patterns.json` | JSON | 用户确认 learn 后 |

### 6.3 中断恢复流程

```
用户执行 code-agent fix "..."
  │
  ▼
检查是否存在未完成任务 ──▶ 是 ──▶ 提示恢复或重新开始
  │                           │
  否                          ▼
  │                    加载最后一个 snapshot
  ▼                           │
创建新 task                   ▼
  │                    从断点 Phase 继续执行
  ▼                           │
正常执行 ◀────────────────────┘
```

---

## 7. 目录结构与文件组织

### 7.1 源码目录（实际结构）

```
src/
├── index.ts                    # 主入口 + CLI 注册（commander）+ Agent 编排（~450 行）
├── core/
│   ├── types.ts                # 核心共享类型 + Zod Schema（320 行）
│   ├── fingerprint.ts          # Tree-sitter 指纹计算 + 变更分类（319 行）
│   ├── knowledge-graph.ts      # 知识图谱构建器 + 索引（100 行）
│   ├── memory.ts               # L1/L2/L3 三层记忆（128 行）
│   ├── repo-scanner.ts         # 仓库扫描器 + Import Map（96 行）
│   ├── patch.ts                # Patch 数据结构 + 应用逻辑（82 行）
│   ├── sync.ts                 # 增量同步核心（163 行）
│   ├── llm-service.ts          # LLM 服务抽象 + Template/Anthropic/Http（425 行）
│   ├── llm-config.ts           # LLM 配置解析 + API key 安全（180 行）
│   ├── propagation.ts          # 故障传播引擎 BFS + 概率衰减（303 行）
│   ├── token-budget.ts         # Token 预算管理 + 四级降级（170 行）
│   ├── token-estimator.ts      # 模型感知 Token 估算（100 行）
│   └── web-search.ts           # Web 搜索引擎 + 查询构建 + 模拟 provider（180 行）
├── agents/
│   ├── base-agent.ts           # Agent 基类（47 行）
│   ├── repo-scanner-agent.ts   # 扫描 Agent（39 行）
│   ├── fault-detector-agent.ts # LLM 增强故障检测（96 行）
│   ├── context-builder-agent.ts# 上下文构建 + 传播集成（55 行）
│   ├── web-searcher-agent.ts   # Web 搜索 Agent（65 行）
│   ├── solution-planner-agent.ts # LLM 增强方案规划 + 搜索集成（85 行）
│   └── patch-generator-agent.ts  # Patch 生成 + LLM 增强（75 行）
├── interface/
│   └── cli-review.ts           # CLI diff 格式化 + Review UI（61 行）
└── utils/
    ├── logger.ts               # 日志工具（36 行）
    └── hash.ts                 # SHA-256 哈希（5 行）
```

**与规划差异说明**：
- ❌ 未创建 `cli/`、`core/agent/`、`core/pipeline/`、`scanners/`、`schemas/`、`types/` 子目录
- ❌ 未实现 `PipelineRunner` 状态机（Agent 直接在 `index.ts` 中顺序编排）
- ❌ Agent 以 TypeScript 类实现，非 Markdown + YAML 配置
- ✅ 核心模块按扁平结构组织，职责清晰，测试覆盖充分

### 7.2 Agent 定义目录

```
docs/agents/
├── repo-scanner.md
├── fault-detector.md
├── context-builder.md
├── root-cause-analyzer.md
├── web-searcher.md
├── solution-planner.md
├── patch-generator.md
└── git-executor.md
```

---

## 8. 开发路线图（可执行版）

### Phase 1: 基础设施 ✅（Week 1-2）

**目标**：搭好骨架，能跑通单个 Agent 的调用

**实际交付**：项目脚手架 + 核心类型 + `RepoScannerAgent` + `init` CLI

| 任务 | 状态 | 实际交付 |
|------|------|----------|
| 引入依赖 | ✅ | `commander` / `zod` / `tree-sitter` / `fuse.js` / `vitest` |
| LLM 服务抽象 | ✅ | `LlmService` 接口 + `TemplateLlmService` |
| 核心 Zod Schema | ✅ | 全量类型定义含 `parseContext` 验证工具 |
| `repo-scanner` Agent | ✅ | `RepoScannerAgent` + 扫描器 + Tree-sitter 解析 |
| CLI `init` 命令 | ✅ | `code-agent init <path>` 生成 `.repair-agent/memory.json` |

**与规划差异**：
- ❌ 未引入 `ai` SDK，改用各 Provider 原生 SDK + 通用 `HttpLlmService`
- ❌ 未实现 `AgentLoader`（Markdown 配置化延后）

### Phase 2: 核心流水线 ✅（Week 3-4）

**目标**：7 个 Phase 能串起来跑完一个完整任务

**实际交付**：`fix` 命令完整闭环（scan → detect → plan → patch → review → apply）

| 任务 | 状态 | 实际交付 |
|------|------|----------|
| Agent 顺序编排 | ✅ | `index.ts` 中直接顺序调用各 Agent |
| `Fingerprint` 模块 | ✅ | Tree-sitter 解析 + 三级变更分类 + LOAD-PATCH-SAVE |
| `fault-detector` + `context-builder` | ✅ | 启发式 + LLM 6 种检测模式 + 邻居遍历 |
| `solution-planner` | ✅ | LLM 生成带 `originalCode`/`modifiedCode` 的方案 |
| `patch-generator` | ✅ | add/modify/delete + 模糊匹配 + 冲突检测 |
| CLI `fix` 命令 | ✅ | 完整交互式修复流程 |

**与规划差异**：
- ❌ 未实现独立 `PipelineRunner` 状态机
- ✅ `root-cause-analyzer` 功能已集成到 `SolutionPlannerAgent`

### Phase 3: 记忆与优化 ✅（Week 5-6）

**目标**：日常任务 token 消耗降低 80%+

**实际交付**：三层记忆 + 传播引擎 + Token 预算 + 增量同步

| 任务 | 状态 | 实际交付 |
|------|------|----------|
| 三层记忆架构 | ✅ | L1 repo + L2 task + L3 learned（结构就绪） |
| 故障传播引擎 | ✅ | BFS + 31 种边规则 + 概率衰减 + 根因候选 |
| Token 预算控制 | ✅ | 四级降级 + 分类跟踪 + 模型感知估算 |
| 增量同步 `sync` | ✅ | `code-agent sync` 自动检测变更并增量更新 |
| Pipeline 中断恢复 | ⬜ | 未实现（Plan 未持久化到磁盘） |

### Phase 4: 联网与 Review ✅（Week 7-8）

**目标**：复杂问题有外部知识补充，修改有审核流程

**实际交付**：Web Search 模拟 + LLM Patch 生成 + Review UI

| 任务 | 状态 | 实际交付 |
|------|------|----------|
| 联网搜索抽象层 | ✅ | `WebSearchEngine` + 4 种查询模板 + 模拟 provider |
| 搜索触发策略 | ✅ | localConfidence < 0.5 自动触发 |
| 结果融合 | ✅ | 加权融合策略（localKnowledge / webSearch / historicalFix） |
| Review 界面（CLI） | ✅ | diff 展示 + approve/reject + Patch 应用 |
| LLM Patch 生成 | ✅ | `generatePatch` 全 Provider 支持 |
| CLI `--web-search` | ✅ | 默认启用，支持 `--no-web-search` 禁用 |
| Git 自动化 | ⬜ | 未实现（Phase 4 延后） |

**与规划差异**：
- ✅ Web Search 模块提前完成并集成到 `plan()` 流程
- ❌ Git 操作（分支/提交/推送）未实现，移至 Phase 4.x

### Phase 5: 学习与进化（Week 9+，持续）

**目标**：Agent 越用越聪明

| 任务 | 状态 | 说明 |
|------|------|------|
| `learn` 命令 | ⬜ | 从历史任务提取故障/修复模式 |
| 模式复用 | ⬜ | 相似问题优先复用历史模式 |
| 项目约定学习 | ⬜ | 自动提取代码风格、命名规范 |
| 性能基准测试 | ⬜ | 建立 token 消耗/耗时基线 |
| 真实 Web Search API | 🔄 | SerpAPI/Tavily/Google 接入（Phase 3.x）|

---

## 9. 接口契约（模块间）

### 9.1 核心模块依赖图

```
CLI Commands ──▶ PipelineRunner ──▶ AgentLoader ──▶ LLMClient
                     │                  │              │
                     ▼                  ▼              ▼
              State Manager      Knowledge Graph    ai SDK
                     │                  │
                     ▼                  ▼
              Memory Layers      Fingerprint Store
                     │
                     ▼
              Propagation Engine
```

### 9.2 禁止的依赖方向

- `core/` 下的模块**不允许**依赖 `cli/`
- `agents/`（Markdown 定义）**不允许**依赖任何代码模块
- `schemas/` **不允许**依赖 `core/`
- `utils/` **不允许**依赖 `core/`

---

## 10. 风险与缓解策略

| 风险 | 概率 | 影响 | 缓解策略 |
|------|------|------|----------|
| ~~`ai` SDK TS 版功能不足~~ | ✅ **规避** | — | 未引入 `ai` SDK，直接使用各 Provider 原生 SDK + 通用 `HttpLlmService` |
| LLM 输出不稳定 | 高 | 高 | Zod 校验 + 重试机制 + 人工介入状态 |
| Tree-sitter WASM 加载问题 | 低 | 高 | 预编译 grammar，CI 中验证加载 |
| 大仓库性能问题 | 中 | 中 | Fingerprint 跳过 + 传播裁剪 + 分阶段性能测试 |
| Token 成本超预期 | 中 | 高 | Token 预算硬限制 + 分级降级策略 + 预算告警 |
| Agent Prompt 迭代困难 | 中 | 中 | Markdown 分离 + A/B 测试框架 + 效果追踪 |

---

## 11. 下一步行动

Phase 1~4 核心功能已完成，当前架构进入稳定期。下一步重点：

1. **评测体系建设** — 端到端测试 + 评测数据集 + 自动化评分
2. **Plan 持久化** — `.repair-agent/plans/` 目录 + `apply` 从磁盘读取
3. **真实 Web Search API** — SerpAPI / Tavily / Google 接入
4. **Git 自动化** — `git checkout -b` / `add` / `commit` / `push` 封装
5. **架构演进** — `index.ts` 拆分 → `cli/` 目录 + `PipelineRunner` 状态机

---

*本文档为实施层面的技术规划，与 DESIGN.md（架构设计）和 CONTEXT.md（项目上下文）配合使用。*
