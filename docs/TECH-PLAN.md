# Code Repair Agent — 技术规划方案

> 实施层面技术规划，指导从设计到代码的落地过程
> 版本: v1.0.0
> 日期: 2026-05-29

---

## 1. 技术选型确认

### 1.1 总体策略

采用**核心手写 + 关键依赖**的轻量架构，不引入重型 Agent 框架。

| 层级 | 策略 | 理由 |
|------|------|------|
| Agent 编排 | **手写 PipelineRunner** | 项目自定义机制（Fingerprint、传播裁剪、Token 预算）与框架抽象冲突 |
| LLM 调用 | **Vercel AI SDK (`ai`)** | TypeScript 原生、多 provider 统一、结构化输出支持 |
| 类型校验 | **Zod** | 运行时校验 + TypeScript 类型推导一体化 |
| CLI 框架 | **commander**（已引入） | 成熟的 Node.js CLI 框架 |
| 代码解析 | **tree-sitter**（已引入） | 已确定，支持 10+ 语言 |
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

### 7.1 源码目录（细化）

```
src/
├── index.ts                    # 主入口，导出 CodeRepairAgent 类
├── cli/
│   ├── index.ts                # CLI 入口（commander 注册）
│   ├── commands/
│   │   ├── init.ts             # code-agent init
│   │   ├── fix.ts              # code-agent fix
│   │   ├── plan.ts             # code-agent plan
│   │   ├── apply.ts            # code-agent apply
│   │   ├── sync.ts             # code-agent sync
│   │   ├── status.ts           # code-agent status
│   │   ├── history.ts          # code-agent history
│   │   └── learn.ts            # code-agent learn
│   └── prompts.ts              # CLI 交互提示（inquirer 风格）
├── core/
│   ├── agent/
│   │   ├── loader.ts           # Agent Markdown 加载解析
│   │   ├── client.ts           # LLMClient 封装
│   │   └── types.ts            # Agent 相关类型
│   ├── pipeline/
│   │   ├── runner.ts           # PipelineRunner 核心
│   │   ├── phases.ts           # Phase 定义与注册
│   │   ├── state.ts            # PipelineState 管理
│   │   └── types.ts            # Pipeline 类型
│   ├── knowledge-graph/
│   │   ├── graph.ts            # KnowledgeGraph 类
│   │   ├── nodes.ts            # 节点类型定义
│   │   ├── edges.ts            # 边类型定义
│   │   ├── builder.ts          # 图谱构建器
│   │   └── persistence.ts      # 图谱持久化
│   ├── fingerprint/
│   │   ├── fingerprint.ts      # 指纹计算（已有）
│   │   ├── classifier.ts       # 变更分类器
│   │   ├── store.ts            # 指纹存储（LOAD-PATCH-SAVE）
│   │   └── types.ts            # 指纹类型
│   ├── propagation/
│   │   ├── engine.ts           # 故障传播分析引擎
│   │   ├── rules.ts            # 传播规则定义
│   │   └── types.ts            # 传播结果类型
│   ├── search/
│   │   ├── local.ts            # fuse.js 本地搜索
│   │   ├── web.ts              # 联网搜索（抽象接口）
│   │   ├── fusion.ts           # 结果融合
│   │   └── types.ts            # 搜索类型
│   ├── memory/
│   │   ├── repo-memory.ts      # L1: 仓库级记忆
│   │   ├── task-memory.ts      # L2: 任务级记忆
│   │   ├── learned-memory.ts   # L3: 学习记忆
│   │   └── types.ts            # 记忆类型
│   └── types.ts                # 核心共享类型（已有）
├── scanners/
│   ├── project-scanner.ts      # 仓库扫描（复用 UA 逻辑）
│   ├── import-extractor.ts     # Import Map 提取
│   └── language-detector.ts    # 语言检测
├── schemas/                    # Zod Schema 定义
│   ├── common.ts
│   ├── scan.ts
│   ├── fault.ts
│   ├── analysis.ts
│   ├── plan.ts
│   └── patch.ts
├── utils/
│   ├── hash.ts                 # 哈希工具（已有）
│   ├── file.ts                 # 文件操作
│   ├── git.ts                  # Git 操作封装
│   └── config.ts               # 配置读取
└── types/                      # 纯类型定义（无 Zod，供外部使用）
    └── index.ts
```

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

### Phase 1: 基础设施（Week 1-2）

**目标**：搭好骨架，能跑通单个 Agent 的调用

| 任务 | 负责人 | 验收标准 |
|------|--------|----------|
| 引入 `ai` + `zod` 依赖 | - | `package.json` 更新，lock 文件同步 |
| 实现 `LLMClient` | - | 支持 `generate` / `generateObject` / `stream`，可切换 provider |
| 实现 `AgentLoader` | - | 能读取 `docs/agents/*.md`，解析 YAML + body |
| 定义核心 Zod Schema（common + scan） | - | 覆盖 `FileManifest`、`ImportMap`、`CodeLocation` |
| 实现 `repo-scanner` Agent + 调用 | - | 输入仓库路径，输出文件清单（端到端跑通） |
| CLI `init` 命令 | - | `code-agent init <path>` 可执行，生成 `.repair-agent/` 目录 |

### Phase 2: 核心流水线（Week 3-4）

**目标**：7 个 Phase 能串起来跑完一个完整任务

| 任务 | 验收标准 |
|------|----------|
| 实现 `PipelineRunner` | 支持顺序执行、Phase 间数据传递、基础错误处理 |
| 实现 `Fingerprint` 模块（完整版） | 含变更分类、增量决策矩阵、LOAD-PATCH-SAVE |
| 实现 `fault-detector` + `context-builder` | 能定位故障并召回相关代码 |
| 实现 `root-cause-analyzer` + `solution-planner` | 输出结构化根因分析和修改方案 |
| 实现 `patch-generator` | 输出标准 unified diff 格式 |
| CLI `fix` 命令（基础版） | `code-agent fix "..."` 能跑完流水线并输出生成的 patch |

### Phase 3: 记忆与优化（Week 5-6）

**目标**：日常任务 token 消耗降低 80%+

| 任务 | 验收标准 |
|------|----------|
| 实现三层记忆架构 | L1/L2/L3 记忆读写正常，数据持久化 |
| 实现故障传播引擎 | 传播分析结果与手工分析一致（抽样验证） |
| 实现 Token 预算控制 | 超预算时触发降级策略，有明确提示 |
| 实现增量同步 `sync` 命令 | `code-agent sync` 只分析变更文件 |
| Pipeline 中断恢复 | `SIGINT` 后重新执行 `fix`，提示是否恢复 |

### Phase 4: 联网与 Review（Week 7-8）

**目标**：复杂问题有外部知识补充，修改有审核流程

| 任务 | 验收标准 |
|------|----------|
| 实现联网搜索抽象层 | 支持至少 1 个搜索 provider，结果含可信度评分 |
| 实现搜索触发策略 | 本地置信度低时自动触发，高时不触发 |
| 实现结果融合 | 本地知识 + 搜索结果融合输出 |
| Review 界面（CLI 版） | 展示 diff、影响分析、风险列表，支持 approve/reject/edit |
| CLI `apply` 命令 | `code-agent apply <plan-id>` 执行 git 操作 |
| Git 安全策略 | 强制 feature 分支、禁止直接推 main、diff 大小限制 |

### Phase 5: 学习与进化（Week 9+，持续）

**目标**：Agent 越用越聪明

| 任务 | 验收标准 |
|------|----------|
| 实现 `learn` 命令 | 从历史任务提取故障/修复模式 |
| 模式复用 | 相似问题优先复用历史模式 |
| 项目约定学习 | 自动提取代码风格、命名规范 |
| 性能基准测试 | 建立 token 消耗/耗时基线，防止退化 |

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
| `ai` SDK TS 版功能不足 | 中 | 中 | 封装 `LLMClient` 接口，预留直接调用 SDK 的降级路径 |
| LLM 输出不稳定 | 高 | 高 | Zod 校验 + 重试机制 + 人工介入状态 |
| Tree-sitter WASM 加载问题 | 低 | 高 | 预编译 grammar，CI 中验证加载 |
| 大仓库性能问题 | 中 | 中 | Fingerprint 跳过 + 传播裁剪 + 分阶段性能测试 |
| Token 成本超预期 | 中 | 高 | Token 预算硬限制 + 分级降级策略 + 预算告警 |
| Agent Prompt 迭代困难 | 中 | 中 | Markdown 分离 + A/B 测试框架 + 效果追踪 |

---

## 11. 下一步行动

1. **确认本方案** — 用户 review 后如无异议，按 Phase 1 开始实施
2. **补充 Agent Prompt 定义** — 先写 `repo-scanner.md`，作为端到端测试的锚点
3. **更新 `package.json`** — 引入 `ai` 和 `zod`
4. **建立目录结构** — 按 7.1 节创建空目录和 `index.ts` 占位文件

---

*本文档为实施层面的技术规划，与 DESIGN.md（架构设计）和 CONTEXT.md（项目上下文）配合使用。*
