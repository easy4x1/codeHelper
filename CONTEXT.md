# 项目上下文摘要

> 本文档记录本项目的背景、需求来源、关键决策和约束条件。

---

## 1. 需求来源

### 1.1 原始需求

用户希望参考 **Understand-Anything** 仓库的 Agent 设计，实现一个具备以下能力的 Agent 系统：

1. **分析代码仓库** — 理解代码结构、依赖关系
2. **记忆中间层** — 通过缓存、指纹等机制降低 token 消耗
3. **联网搜索** — 在本地知识不足时搜索故障解决方案
4. **输出修改方案** — 生成结构化的代码修复计划
5. **用户 Review 后推送** — 审核通过后自动执行 git 操作推送代码

### 1.2 关键约束

- **先分析，不直接落地** — 用户明确要求先进行架构分析，再决定是否实现
- **参考 Understand-Anything** — 核心设计思想（多 Agent、Fingerprint、增量更新）需保持一致
- **Token 优化优先** — 记忆中间层是核心诉求之一
- **安全可控** — 代码修改必须经过用户 Review

---

## 2. 分析过程

### 2.1 Understand-Anything 分析

通过克隆仓库并深入分析以下方面：

- **整体架构**: Tree-sitter + LLM 混合架构，7 个专用 Agent 协作
- **核心机制**: Structural Fingerprinting、增量更新、预计算传递
- **代码结构**: `packages/core`（核心库）+ `agents/`（Agent 定义）+ `skills/`（技能编排）
- **关键文件**: `fingerprint.ts`、`change-classifier.ts`、`search.ts`、`types.ts`
- **Agent 定义**: Markdown + YAML Frontmatter 格式，标准化输入输出

### 2.2 关键发现

详见 `KEY-FINDINGS.md`，核心发现包括：

- Fingerprint 机制可实现日常任务 **80-95%** 的 token 节省
- Agent 职责单一化是并行和可维护的关键
- 预计算（Import Map、Batch 划分、NeighborMap）避免重复工作
- LOAD-PATCH-SAVE 模式是增量更新的正确实践

---

## 3. 设计决策

### 3.1 已确定的决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 架构风格 | 多 Agent 流水线 | 复用 UA 的成熟模式，职责清晰 |
| 代码分析 | Tree-sitter + LLM 混合 | 确定性 + 语义深度兼顾 |
| Token 优化 | Fingerprint + 故障传播裁剪 | UA 经验 + 修复场景特化 |
| 记忆层 | 三层架构（Repo/Task/Learned） | 满足不同时间跨度的记忆需求 |
| 修改控制 | 必须人工 Review | 安全约束，不可绕过 |
| 输出格式 | Markdown 方案 + diff 补丁 | 人类可读 + 机器可执行 |

### 3.2 已确定的决策

| 项 | 选择 | 理由 |
|----|------|------|
| 实现语言 | **TypeScript** | 与 UA 一致，便于复用代码结构 |
| 部署方式 | **CLI**（未来可扩展 Web/IDE） | 先验证核心闭环，再扩展交互形态 |
| 联网搜索 | **抽象接口 + 模拟 Provider** | `WebSearchEngine` 支持多源，当前为模拟实现，预留真实 API 接入点 |
| 向量嵌入 | **暂不实现** | 当前基于图谱邻居 + 故障传播已满足需求，Phase 5 再评估 |
| Git 平台 | **抽象 Git 操作层** | Phase 4 实现通用 Git 自动化，不限定平台 |

---

## 4. 相关资源

### 4.1 参考项目

- **[Understand-Anything](https://github.com/Lum1104/Understand-Anything)** (v2.7.5)
  - 多 Agent 架构参考
  - Fingerprint 机制参考
  - 增量更新策略参考
  - 知识图谱格式参考

### 4.2 技术栈

| 组件 | 选择 | 说明 |
|------|------|------|
| 代码解析 | Tree-sitter | UA 使用的解析器，支持 10+ 语言 |
| 本地搜索 | fuse.js | UA 使用的模糊搜索库 |
| 语义搜索 | 向量嵌入 + 余弦相似度 | UA 已实现 |
| 配置管理 | YAML + JSON | 兼顾人类可读和机器解析 |
| 测试 | vitest | UA 使用的测试框架 |

### 4.3 文档索引

```
~/code-agent/
├── DESIGN.md          # 系统设计方案（主文档）
├── KEY-FINDINGS.md    # UA 深度分析关键发现
├── CONTEXT.md         # 本文件（上下文摘要）
├── PROGRESS.md        # 实现进度报告（随迭代更新）
├── PROJECT-GUIDE.md   # 项目使用指南（面向集成开发者）
├── README.md          # 项目入口文档
└── docs/              # 详细文档目录
    ├── ARCHITECTURE.md            # 系统架构详解
    ├── API.md                     # CLI 与程序化 API 参考
    ├── GRAPH-ENRICHMENT-PLAN.md   # 知识图谱 A/B/C/D 层语义增强方案
    ├── D-LAYER-IMPLEMENTATION.md  # D 层 LLM 语义增强执行文档
    └── EMBEDDING-SETUP.md         # C 层 Embedding 模型设置指南
```

---

## 5. 后续行动

### 5.1 已完成的里程碑

| 阶段 | 状态 | 关键交付 |
|------|------|---------|
| Phase 1: MVP | ✅ 完成 | 核心闭环（scan → detect → plan → patch → review）|
| Phase 2: Memory Optimization | ✅ 完成 | Fingerprint 增量、故障传播裁剪、Token 预算 |
| Phase 3: Web Enhancement | ✅ 完成 | Web Search、LLM Patch 生成、结果融合 |

### 5.2 下一步工作（按优先级）

1. **Phase 3.x: 真实 Web Search API 接入** — Google/Bing 等真实搜索 provider
2. **Phase 4: Git 自动化** — 分支创建、提交、推送、PR 自动化
3. **Phase 5: 学习进化** — 历史任务模式提取、项目约定学习
4. **CI/CD 搭建** — 自动化测试、发布流程

---

*本文档随项目进展持续更新。*
