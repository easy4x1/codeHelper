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

### 3.2 待决策项

| 项 | 选项 | 建议 |
|----|------|------|
| 实现语言 | TypeScript / Python / Go | **TypeScript**（与 UA 一致，便于复用） |
| 部署方式 | CLI / Web / IDE Plugin | 先 CLI，再扩展 |
| 联网搜索 | Google API / Bing / 自建 | 抽象接口，支持多源 |
| 向量嵌入 | OpenAI / local / 混合 | 优先 local（节省 token） |
| Git 平台 | GitHub / GitLab / 通用 | 抽象 Git 操作层 |

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
└── docs/              # 详细文档目录（待创建）
    ├── ARCHITECTURE.md
    ├── AGENTS.md
    ├── API.md
    └── DEPLOYMENT.md
```

---

## 5. 后续行动

### 5.1 等待用户决策

- [ ] 确认实现语言（建议 TypeScript）
- [ ] 确认第一阶段范围（建议 MVP：核心闭环）
- [ ] 确认目标仓库（用于开发和测试）

### 5.2 下一步工作

1. 创建详细的 Agent Prompt 定义（参考 UA 的 Markdown 格式）
2. 设计知识图谱的扩展类型（增加 fault/fix/pattern 节点）
3. 实现 Fingerprint 模块的核心逻辑
4. 搭建项目脚手架和 CI/CD

---

*本文档随项目进展持续更新。*
