# Code Repair Agent - 系统设计方案

> 基于 Understand-Anything 多 Agent 架构的代码修复 Agent 系统设计
> 版本: v1.0.0
> 日期: 2026-05-28

---

## 1. 项目背景与目标

### 1.1 背景

Understand-Anything 是一个优秀的多 Agent 代码分析系统，通过 Tree-sitter + LLM 混合架构、Structural Fingerprinting、增量更新等机制，实现了高效的代码知识图谱构建。本设计参考其核心思想，构建一个面向**代码故障修复**场景的 Agent 系统。

### 1.2 目标

构建一个能够：

1. **分析代码仓库** — 理解代码结构、依赖关系、业务逻辑
2. **诊断问题根因** — 基于代码分析定位故障源头
3. **联网搜索补充** — 在本地知识不足时搜索解决方案
4. **生成修改方案** — 输出结构化的代码修复计划
5. **支持人工 Review** — 用户审核后可一键应用
6. **自动推送代码** — 执行 git 流程，将修改推送到仓库

---

## 2. 系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                        用户交互层 (CLI / Web)                         │
├─────────────────────────────────────────────────────────────────────┤
│  Planner (任务规划) │ Reviewer (人工审核) │ Executor (执行引擎)        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │
│  │   Scanner   │  │   Memory    │  │   Search    │                 │
│  │  (仓库扫描)  │  │ Middleware  │  │   Engine    │                 │
│  │             │  │ (记忆中间层) │  │ (联网搜索)   │                 │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                 │
│         │                │                │                         │
│         └────────────────┼────────────────┘                         │
│                          ▼                                          │
│               ┌─────────────────────┐                               │
│               │   Analyzer Core     │                               │
│               │  (故障分析与诊断)    │                               │
│               └──────────┬──────────┘                               │
│                          │                                          │
│                          ▼                                          │
│               ┌─────────────────────┐                               │
│               │  Solution Generator │                               │
│               │   (方案生成器)       │                               │
│               └──────────┬──────────┘                               │
│                          │                                          │
│                          ▼                                          │
│               ┌─────────────────────┐                               │
│               │   Patch Generator   │                               │
│               │   (补丁生成器)       │                               │
│               └─────────────────────┘                               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 核心 Agent 定义

借鉴 Understand-Anything 的专用 Agent 模式，定义以下 Agent：

| Agent | 职责 | 输入 | 输出 |
|-------|------|------|------|
| `repo-scanner` | 扫描仓库结构，提取文件列表、依赖、语言框架 | 仓库路径 | 文件清单 + Import Map + 指纹基线 |
| `fault-detector` | 定位代码中的问题点 | 用户输入 / 自动扫描规则 | 故障位置 + 类型 + 严重程度 |
| `context-builder` | 召回与问题相关的代码上下文 | 故障位置 + 知识图谱 | 相关代码片段 + 调用链 |
| `web-searcher` | 联网搜索类似问题的解决方案 | 故障特征 | 搜索结果 + 可信度评分 |
| `root-cause-analyzer` | 综合分析，定位根因 | 代码上下文 + 搜索结果 | 根因分析报告 |
| `solution-planner` | 输出结构化的代码修改方案 | 根因分析 | 修改方案 (Markdown) |
| `patch-generator` | 将方案转换为具体代码 diff | 修改方案 + 原代码 | 文件补丁 |
| `git-executor` | 执行 git 操作 | 补丁 + 分支策略 | 提交记录 |

---

## 3. 核心模块设计

### 3.1 知识图谱模块 (Knowledge Graph)

复用并扩展 Understand-Anything 的知识图谱格式：

```typescript
// 基础节点类型（复用 UA）
type NodeType = 
  | "file" | "function" | "class" | "module" | "concept"
  | "config" | "document" | "service" | "table" | "endpoint"
  | "pipeline" | "schema" | "resource"
  // 扩展类型
  | "fault"      // 故障节点
  | "fix"        // 修复节点
  | "pattern";   // 模式节点

// 边类型（复用 UA）
type EdgeType =
  // ... UA 原有边类型
  | "fixes"          // 修复关系
  | "mitigates"      // 缓解关系
  | "relates_to_fault" // 与故障相关
  | "suggests"       // 建议关系
  | "learned_from";  // 学习来源

// 故障节点
interface FaultNode extends GraphNode {
  type: "fault";
  faultType: "bug" | "performance" | "security" | "style" | "compatibility";
  severity: "critical" | "major" | "minor" | "info";
  location: CodeLocation;
  description: string;
  errorPattern?: string;    // 错误模式签名
  stackTrace?: string;
}

// 修复节点
interface FixNode extends GraphNode {
  type: "fix";
  fixType: "code_change" | "config_change" | "dependency_update" | "refactor";
  targetNodes: string[];    // 修复目标节点 ID
  confidence: number;       // 修复置信度 0-1
  sideEffects?: string[];   // 可能的副作用
}
```

### 3.2 记忆中间层 (Memory Middleware)

#### 3.2.1 三层记忆架构

```typescript
interface MemoryLayer {
  // L1: 仓库级静态知识（长期存储，多任务共享）
  repoMemory: {
    knowledgeGraph: KnowledgeGraph;      // 代码结构图谱
    fingerprints: FingerprintStore;      // 文件结构指纹
    importMap: ImportMap;                // 模块依赖关系
    apiIndex: APIIndex;                  // 对外接口索引
    embeddings: EmbeddingStore;          // 语义向量嵌入
  };

  // L2: 任务级动态记忆（单次任务生命周期）
  taskContext: {
    taskId: string;
    analyzedFiles: Set<string>;          // 已分析文件集合
    recalledNodes: GraphNode[];          // 已召回节点
    searchCache: SearchCache;            // 搜索结果缓存
    findings: Finding[];                 // 中间发现
    tokenBudget: TokenBudget;            // Token 预算
  };

  // L3: 跨任务学习记忆（长期积累，越用越聪明）
  learnedMemory: {
    taskHistory: TaskRecord[];           // 历史任务记录
    faultPatterns: FaultPattern[];       // 故障模式库
    fixPatterns: FixPattern[];           // 修复模式库
    projectConventions: Convention[];    // 项目约定
  };
}
```

#### 3.2.2 文件指纹机制 (Fingerprinting)

借鉴 Understand-Anything 的指纹机制，针对修复场景扩展：

```typescript
interface FileFingerprint {
  filePath: string;
  contentHash: string;                  // SHA-256 内容哈希
  
  // 结构签名（UA 原有）
  functions: FunctionSignature[];
  classes: ClassSignature[];
  imports: ImportSignature[];
  exports: ExportSignature[];
  
  // 语义签名（新增）
  semanticEmbedding: number[];          // 文件语义向量
  apiSurface: APISignature[];           // 对外接口签名
  
  totalLines: number;
  hasStructuralAnalysis: boolean;
}

type ChangeLevel = "NONE" | "COSMETIC" | "STRUCTURAL" | "SEMANTIC";

interface ChangeAnalysis {
  filePath: string;
  changeLevel: ChangeLevel;
  details: string[];
  
  // 影响评估
  impact: {
    affectedCallers: string[];          // 受影响的调用方
    affectedTests: string[];            // 受影响的测试
    breakingChange: boolean;            // 是否为破坏性变更
  };
}
```

#### 3.2.3 增量分析决策矩阵

| 指纹状态 | 任务相关性 | 分析动作 | Token 消耗 |
|----------|-----------|---------|-----------|
| 无变化 + 低相关 | < 0.3 | **SKIP** | 0 |
| 无变化 + 高相关 | >= 0.3 | **RECALL_ONLY** | 0 |
| 仅内容变化 | - | **RECALL_ONLY** | 0 |
| 结构变化 | - | **PARTIAL_REANALYZE** | 低 |
| 新增文件 | - | **FULL_REANALYZE** | 中 |
| 语义变化 | - | **SEMANTIC_REANALYZE** | 高 |

### 3.3 故障传播分析引擎

核心创新模块，替代 UA 的"全量分析"：

```typescript
interface FaultPropagationEngine {
  // 从故障点出发，沿调用链传播分析
  trace(
    entryPoint: FaultLocation,
    knowledgeGraph: KnowledgeGraph,
    options: PropagationOptions
  ): PropagationResult;
}

interface PropagationOptions {
  direction: "upstream" | "downstream" | "both";  // 传播方向
  maxDepth: number;                                // 最大传播深度
  minEdgeWeight: number;                           // 最小边权重阈值
  includeTests: boolean;                           // 是否包含测试文件
}

interface PropagationResult {
  affectedNodes: AffectedNode[];                   // 受影响节点（按概率排序）
  rootCauseCandidates: RootCause[];                // 根因候选
  propagationPath: PropagationPath[];              // 传播路径
}

interface AffectedNode {
  nodeId: string;
  nodeType: NodeType;
  impactProbability: number;                       // 影响概率 0-1
  distance: number;                                // 距离故障点的跳数
  path: string[];                                  // 传播路径
}
```

**传播规则**：

1. **Import 边** (weight: 0.7): 被导入方故障 → 导入方高概率受影响
2. **Calls 边** (weight: 0.8): 被调用方故障 → 调用方高概率受影响
3. **Contains 边** (weight: 1.0): 父节点故障 → 子节点必然受影响
4. **Inherits 边** (weight: 0.9): 父类故障 → 子类高概率受影响

### 3.4 联网搜索模块

```typescript
interface WebSearchStrategy {
  // 触发条件
  triggers: {
    localConfidenceThreshold: number;    // 本地置信度低于此值时触发
    noveltyThreshold: number;            // 新颖性阈值
    minQueryQuality: number;             // 最小查询质量
  };

  // 查询生成
  queryBuilder: {
    templates: SearchTemplate[];
    enrichment: {
      includeStackTrace: boolean;
      includeVersions: boolean;
      includeContext: boolean;
    };
  };

  // 结果融合
  fusion: {
    strategy: "weighted" | "fallback" | "ensemble";
    weights: {
      localKnowledge: number;
      webSearch: number;
      historicalFix: number;
    };
  };
}

interface SearchTemplate {
  name: string;
  template: string;
  priority: number;
  example: string;
}

// 内置查询模板
const DEFAULT_TEMPLATES: SearchTemplate[] = [
  {
    name: "error_message",
    template: "{errorMessage} {language} {framework}",
    priority: 1,
    example: "TypeError: Cannot read property 'map' of undefined react"
  },
  {
    name: "stack_trace",
    template: "{topFrame} {library} {version} bug",
    priority: 2,
    example: "useEffect cleanup memory leak react 18"
  },
  {
    name: "pattern",
    template: "{framework} {pattern} best practice",
    priority: 3,
    example: "vue composition api error handling pattern"
  },
  {
    name: "compatibility",
    template: "{library} {version} breaking change migration",
    priority: 4,
    example: "typescript 5.0 decorators breaking change"
  }
];
```

### 3.5 方案生成模块

```typescript
interface SolutionPlan {
  // 元信息
  id: string;
  timestamp: string;
  taskId: string;

  // 问题定义
  problem: {
    description: string;           // 问题描述
    rootCause: string;             // 根因分析
    severity: string;              // 严重程度
    scope: ImpactScope;            // 影响范围
  };

  // 修改方案
  changes: FileChange[];           // 逐文件修改

  // 测试策略
  testing: {
    affectedTests: string[];       // 受影响的测试
    newTests: string[];            // 建议新增测试
    testCommand: string;           // 测试命令
  };

  // 风险与回滚
  risks: Risk[];                   // 风险列表
  rollback: RollbackStrategy;      // 回滚策略

  // 元数据
  metadata: {
    confidence: number;            // 整体置信度
    tokenUsed: number;             // 消耗的 token
    searchResultsUsed: number;     // 使用的搜索结果数
  };
}

interface FileChange {
  filePath: string;
  changeType: "modify" | "add" | "delete" | "rename";
  description: string;             // 修改说明
  reasoning: string;               // 修改理由
  
  // 代码变更
  originalCode?: string;           // 原代码（用于 review）
  modifiedCode?: string;           // 修改后代码
  diff?: string;                   // diff 格式
  
  // 依赖影响
  affectedImports: string[];       // 受影响的导入
  affectedExports: string[];       // 受影响的导出
}
```

### 3.6 Review 与执行模块

```typescript
interface ReviewWorkflow {
  // Review 界面数据
  reviewData: {
    plan: SolutionPlan;
    diffPreview: FileDiff[];
    testResults?: TestResult;
    impactAnalysis: ImpactAnalysis;
  };

  // 用户操作
  actions: {
    approve: () => Promise<ExecutionResult>;
    requestChanges: (feedback: string) => Promise<PlanRevision>;
    reject: (reason: string) => Promise<void>;
    edit: (manualEdits: ManualEdit[]) => Promise<PlanRevision>;
  };
}

interface GitExecutionConfig {
  strategy: "direct_commit" | "feature_branch" | "pull_request";
  
  // 分支策略
  branch: {
    prefix: string;                // 分支前缀，如 "fix/"
    naming: "auto" | "manual";     // 命名方式
    baseBranch: string;            // 基于哪个分支
  };

  // 提交策略
  commit: {
    messageTemplate: string;       // 提交信息模板
    signOff: boolean;              // 是否 sign-off
    gpgSign: boolean;              // 是否 GPG 签名
  };

  // 推送策略
  push: {
    remote: string;                // 远程仓库
    force: boolean;                // 是否强制推送
    createPR: boolean;             // 是否创建 PR
  };
}
```

---

## 4. 数据流设计

### 4.1 主流程数据流

```
[用户输入] ──▶ [Task Planner] ──┬──▶ [Repo Scanner] ──▶ [Knowledge Graph]
                                 │                           │
                                 │                           ▼
                                 │                    [Memory Middleware]
                                 │                    (指纹比对 / 增量决策)
                                 │                           │
                                 │                           ▼
                                 │              [Fault Propagation Engine]
                                 │              (定位影响范围，裁剪分析集)
                                 │                           │
                                 ├──▶ [Context Builder] ◀────┘
                                 │      (召回相关代码上下文)
                                 │           │
                                 │           ▼
                                 ├──▶ [Web Searcher] (条件触发)
                                 │      (补充外部知识)
                                 │           │
                                 │           ▼
                                 ├──▶ [Root Cause Analyzer]
                                 │      (综合分析，定位根因)
                                 │           │
                                 │           ▼
                                 ├──▶ [Solution Planner]
                                 │      (生成修改方案)
                                 │           │
                                 │           ▼
                                 └──▶ [Review Interface]
                                        (用户审核)
                                           │
                              ┌────────────┼────────────┐
                              ▼            ▼            ▼
                         [批准]         [修改]         [拒绝]
                              │            │            │
                              ▼            ▼            ▼
                    [Patch Generator]  [迭代优化]    [记录反馈]
                              │
                              ▼
                    [Git Executor]
                    (分支 / 提交 / 推送)
```

### 4.2 Token 优化数据流

```
全量代码 ──▶ [Fingerprint Check] ──┬──▶ 无变化 ──▶ [SKIP] ──▶ 0 token
                                   │
                                   ├──▶ 仅格式变化 ──▶ [RECALL] ──▶ 0 token
                                   │
                                   └──▶ 结构变化 ──▶ [Propagator] ──▶ 裁剪分析集
                                                                      │
                                                                      ▼
                                                              [Partial Analysis]
                                                              (仅分析传播路径)
                                                                      │
                                                                      ▼
                                                              [Update Graph]
                                                              (增量更新图谱)
```

---

## 5. 存储设计

### 5.1 目录结构

```
~/code-agent/
├── DESIGN.md                    # 本设计文档
├── docs/
│   ├── ARCHITECTURE.md          # 架构详细说明
│   ├── AGENTS.md                # Agent 定义与 Prompt
│   ├── API.md                   # 接口文档
│   └── DEPLOYMENT.md            # 部署指南
├── src/
│   ├── core/
│   │   ├── knowledge-graph/     # 知识图谱模块
│   │   ├── fingerprint/         # 指纹模块
│   │   ├── search/              # 搜索模块（本地 + 联网）
│   │   ├── propagation/         # 故障传播分析
│   │   └── memory/              # 记忆中间层
│   ├── agents/
│   │   ├── repo-scanner/        # 仓库扫描 Agent
│   │   ├── fault-detector/      # 故障检测 Agent
│   │   ├── context-builder/     # 上下文构建 Agent
│   │   ├── web-searcher/        # 联网搜索 Agent
│   │   ├── root-cause/          # 根因分析 Agent
│   │   ├── solution-planner/    # 方案规划 Agent
│   │   ├── patch-generator/     # 补丁生成 Agent
│   │   └── git-executor/        # Git 执行 Agent
│   ├── interface/
│   │   ├── cli/                 # 命令行界面
│   │   └── web/                 # Web 界面（可选）
│   └── utils/
├── templates/
│   ├── solution/                # 方案模板
│   └── review/                  # Review 模板
├── tests/
│   ├── unit/                    # 单元测试
│   ├── integration/             # 集成测试
│   └── fixtures/                # 测试固件
└── config/
    ├── default.yaml             # 默认配置
    └── schema.json              # 配置 Schema
```

### 5.2 运行时数据目录

```
.repair-agent/                   # 位于目标仓库根目录
├── config.json                  # 代理配置
├── repo-memory/
│   ├── knowledge-graph.json     # 代码知识图谱
│   ├── fingerprints.json        # 文件指纹库
│   ├── embeddings.json          # 语义嵌入
│   └── version.json             # 版本信息
├── task-memory/
│   ├── task-history.json        # 历史任务记录
│   ├── fault-patterns.json      # 故障模式库
│   └── fix-patterns.json        # 修复模式库
└── cache/
    ├── search/                  # 搜索结果缓存
    ├── analysis/                # 分析结果缓存
    └── embeddings/              # 嵌入向量缓存
```

---

## 6. 接口设计

### 6.1 CLI 接口

```bash
# 初始化 Agent（扫描仓库，建立知识图谱）
code-agent init [repo-path]

# 分析并修复问题（交互式）
code-agent fix "登录接口返回 500 错误"

# 分析并修复问题（自动模式，直接推送）
code-agent fix "内存泄漏问题" --auto-push

# 基于错误日志修复
code-agent fix --log error.log

# 仅生成方案，不执行
code-agent plan "重构用户认证模块"

# 应用已审核的方案
code-agent apply <plan-id>

# 查看历史任务
code-agent history

# 学习模式（从已完成的任务中提取模式）
code-agent learn

# 增量更新知识图谱
code-agent sync

# 查看知识图谱状态
code-agent status
```

### 6.2 核心 API

```typescript
// 主入口
class CodeRepairAgent {
  constructor(config: AgentConfig);

  // 初始化仓库
  async init(repoPath: string): Promise<InitResult>;

  // 执行修复任务（完整闭环：plan → applyPlan）
  async repair(task: RepairTask, options?: ApplyPlanOptions): Promise<RepairOutcome>;

  // 生成方案（不执行）；recordMetric 控制是否记录 plan 指标（fix 工作流传 false 避免双发）
  async plan(task: RepairTask, options?: { recordMetric?: boolean }): Promise<SolutionPlan>;

  // 应用已持久化的方案（按 id 从仓库加载）
  async apply(planId: string, repoPath: string, options?: ApplyPlanOptions): Promise<RepairOutcome>;

  // 应用一个内存中的方案：patch → review → apply → git → record
  async applyPlan(plan: SolutionPlan, options?: ApplyPlanOptions): Promise<RepairOutcome>;

  // 查询状态
  status(): AgentStatus;
}
```

> **实现差异说明（与上文契约对齐）**
>
> 1. **`apply()` 增加 `repoPath` 参数** — 方案以 `<repo>/.repair-agent/plans/` 持久化,按 id 加载时必须知道目标仓库,故实际签名为 `apply(planId, repoPath, options)`。
> 2. **`sync()` 未挂在类上** — 增量同步实现为独立函数 `syncRepo()`(`src/core/sync.ts`)+ `code-agent sync` CLI 命令,而非 `CodeRepairAgent` 方法;`init`/`repair` 等闭环 API 不依赖它。
> 3. **`repair()`/`apply()` 统一返回 `RepairOutcome`** — 三个入口(`repair`/`apply`/CLI fix/apply/batch)共享单一编排路径 `applyPlan()`(patch → review → apply → git → record),`RepairResult`/`ApplyResult` 已合并为 `RepairOutcome`。

// 任务定义
interface RepairTask {
  id: string;
  description: string;           // 问题描述
  type: "bug" | "feature" | "refactor" | "performance" | "security";
  priority: "low" | "medium" | "high" | "urgent";
  
  // 上下文
  context?: {
    files?: string[];            // 指定文件
    errorLog?: string;           // 错误日志
    stackTrace?: string;         // 堆栈跟踪
    relatedIssue?: string;       // 关联 Issue
  };

  // 约束
  constraints?: {
    maxFiles?: number;           // 最大修改文件数
    breakingChanges?: boolean;   // 是否允许破坏性变更
    testRequired?: boolean;      // 是否要求测试
  };

  // 执行选项
  options?: {
    autoPush?: boolean;          // 是否自动推送
    dryRun?: boolean;            // 是否试运行
    reviewRequired?: boolean;    // 是否需要人工审核
  };
}
```

---

## 7. Token 优化策略

### 7.1 优化矩阵

| 策略 | 机制 | 适用场景 | 预期节省 |
|------|------|---------|---------|
| **Fingerprint 跳过** | 文件未变化时直接复用上次分析结果 | 日常增量任务 | **80-95%** |
| **故障传播裁剪** | 仅分析故障传播路径上的文件 | 局部故障修复 | **70-90%** |
| **语义缓存** | 相似问题复用分析结果（基于向量相似度） | 重复类型问题 | **60-80%** |
| **增量图谱更新** | 只更新变化的节点和边 | 代码有变更 | **90%+** |
| **搜索降级** | 本地知识足够时不触发联网搜索 | 常见/已知问题 | **100%**（搜索 token） |
| **上下文压缩** | 用知识图谱替代全量代码上下文 | 大仓库分析 | **50-70%** |
| **Batch 并行** | 多文件并行分析 | 多文件修改 | 时间节省 |
| **结果缓存** | 缓存搜索结果、分析结果 | 重复查询 | **80%+** |

### 7.2 Token 预算控制

```typescript
interface TokenBudget {
  total: number;                   // 总预算
  allocated: {
    analysis: number;              // 代码分析
    search: number;                // 联网搜索
    planning: number;              // 方案生成
    review: number;                // Review 交互
  };
  used: number;                    // 已使用
  remaining: number;               // 剩余

  // 动态调整
  adjust(strategy: "strict" | "adaptive" | "generous"): void;
}

// 预算超限时的降级策略
const DEGRADATION_STRATEGY = {
  // Level 1: 减少搜索深度
  reduceSearchDepth: (budget: TokenBudget) => {
    if (budget.remaining < budget.total * 0.3) {
      return { maxSearchResults: 3 };
    }
  },

  // Level 2: 禁用联网搜索
  disableWebSearch: (budget: TokenBudget) => {
    if (budget.remaining < budget.total * 0.2) {
      return { webSearch: false };
    }
  },

  // Level 3: 仅分析核心文件
  coreOnlyAnalysis: (budget: TokenBudget) => {
    if (budget.remaining < budget.total * 0.1) {
      return { maxFiles: 3, depth: 2 };
    }
  },

  // Level 4: 提示用户
  promptUser: (budget: TokenBudget) => {
    if (budget.remaining < budget.total * 0.05) {
      return { action: "prompt_continue" };
    }
  }
};
```

---

## 8. 安全与风险控制

### 8.1 代码安全

| 风险 | 防护措施 |
|------|---------|
| 恶意代码注入 | 所有修改必须经过 Review 界面；禁止自动执行高危操作 |
| 敏感信息泄露 | 自动检测并脱敏日志/配置中的密钥、token |
| 破坏性变更 | 默认禁止破坏性变更；需显式开启 `--allow-breaking` |
| 依赖污染 | 修改 package.json 等依赖文件时额外确认 |

### 8.2 Git 安全

| 操作 | 默认策略 |
|------|---------|
| 分支创建 | 必须创建 feature 分支，禁止直接修改 main/master |
| 强制推送 | 默认禁用，需显式开启 |
| 提交签名 | 可选 GPG 签名 |
| 大文件检测 | 自动检测并警告 > 1MB 的变更 |

### 8.3 Review 安全网

```typescript
interface SafetyNet {
  // 自动检查
  autoChecks: {
    syntaxCheck: boolean;          // 语法检查
    testRun: boolean;              // 运行测试
    lintCheck: boolean;            // 代码规范检查
    diffSizeLimit: number;         // Diff 大小限制（行数）
    fileCountLimit: number;        // 修改文件数限制
  };

  // 人工确认
  manualConfirm: {
    breakingChanges: boolean;      // 破坏性变更
    configChanges: boolean;        // 配置变更
    dependencyChanges: boolean;    // 依赖变更
    deleteOperations: boolean;     // 删除操作
  };
}
```

---

## 9. 实现路线图

### Phase 1: MVP（核心闭环）- 4 周

- [ ] 实现 `repo-scanner`（复用 UA 的 scan-project + extract-import-map）
- [ ] 实现基础 Knowledge Graph 构建
- [ ] 实现 `fault-detector` + `context-builder`
- [ ] 实现 `solution-planner`（基础方案生成）
- [ ] 实现 CLI 交互界面
- [ ] 实现简单的 Review + Patch 流程

**目标**: 能够完成"输入问题 → 分析 → 生成方案 → 应用修改"的基础闭环

### Phase 2: 记忆优化 - 3 周

- [ ] 实现 Fingerprint 机制
- [ ] 实现增量分析决策
- [ ] 实现故障传播分析引擎
- [ ] 实现任务级上下文缓存
- [ ] Token 预算控制

**目标**: 日常任务的 token 消耗降低 80%+

### Phase 3: 联网增强 - 2 周

- [ ] 接入 Web Search API
- [ ] 实现搜索触发策略
- [ ] 实现结果融合算法
- [ ] 搜索结果缓存

**目标**: 复杂/新颖问题的解决方案覆盖率提升 50%+

### Phase 4: 自动化与集成 - 2 周

- [ ] Git 操作自动化
- [ ] CI/CD 集成
- [ ] 批量任务处理
- [ ] 团队协作支持

**目标**: 实现"一键修复 → 自动推送"的完整自动化流程

### Phase 5: 学习与进化 - 持续

- [ ] 从历史任务提取模式
- [ ] 项目约定自动学习
- [ ] 个性化推荐
- [ ] A/B 测试框架

**目标**: Agent 越用越聪明，复用率持续提升

---

## 10. 参考与致谢

### 10.1 核心参考

- **[Understand-Anything](https://github.com/Lum1104/Understand-Anything)**: 多 Agent 架构、Fingerprint 机制、增量更新策略的主要参考
- **Tree-sitter**: 代码解析基础设施
- **fuse.js**: 本地模糊搜索

### 10.2 设计原则

1. **确定性优先**: 能用静态分析解决的，不用 LLM
2. **增量优于全量**: 只分析变化的部分
3. **本地优于远程**: 本地知识能解决的，不联网搜索
4. **人工确认**: 所有代码修改必须经过人工 Review
5. **可解释**: 每个决策都有明确的理由和置信度

---

*本文档为 Code Repair Agent 的系统设计方案，后续实现请参考 `docs/` 目录下的详细文档。*
