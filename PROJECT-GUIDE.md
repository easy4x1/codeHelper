# Code Repair Agent — 项目使用指南

> 本文档面向基于本项目构建 Web 应用的开发者，说明 `code-repair-agent` 解决了什么问题、核心能力是什么、以及如何以编程方式使用它。

---

## 1. 项目定位

**Code Repair Agent** 是一个 AI 驱动的代码修复系统。它不是一个简单的 "AI 写代码" 工具，而是一个**结构化的多 Agent 流水线**，能够：

1. **理解代码仓库** — 扫描代码结构、构建知识图谱、计算文件指纹
2. **定位故障** — 基于 Tree-sitter AST 分析和 LLM 语义分析检测问题
3. **分析影响范围** — 沿调用链传播分析，只关注相关代码（而非全仓库）
4. **联网搜索补充** — 本地知识不足时自动搜索类似问题的解决方案
5. **生成修复方案** — 输出结构化的修改计划，包含原始代码和修改后代码
6. **人工审核后执行** — diff 预览 → 用户确认 → 自动 git 分支/提交/推送
7. **越用越聪明** — 从历史任务中提取故障模式、学习项目约定、推荐相似解决方案

### 一句话总结

> "输入一个问题描述，Agent 自动分析代码、找到根因、搜索外部知识、生成修复方案、经你确认后自动推送到仓库。"

---

## 2. 核心架构（8 个 Agent 流水线）

```
用户输入 → [Task Planner]
              ↓
         [Repo Scanner] → 知识图谱 + 文件指纹
              ↓
         [Fault Detector] → 问题定位
              ↓
         [Context Builder] → 召回相关代码（传播裁剪）
              ↓
         [Web Searcher] → Tavily/DuckDuckGo 搜索（条件触发）
              ↓
         [Root Cause Analyzer] → 根因定位
              ↓
         [Solution Planner] → 结构化修复方案
              ↓
         [Patch Generator] → 代码 diff
              ↓
         [Review Interface] → 用户确认
              ↓
         [Git Executor] → 分支 → 提交 → 推送
              ↓
         [Learning Agent] → 记录模式、学习约定
```

---

## 3. 三层记忆架构

| 层级 | 存储内容 | 生命周期 | 用途 |
|------|---------|---------|------|
| **L1: Repo Memory** | 知识图谱、文件指纹、导入映射 | 长期，多任务共享 | 避免重复扫描 |
| **L2: Task Memory** | 当前任务上下文、Token 预算、搜索缓存 | 单次任务 | 任务内状态管理 |
| **L3: Learned Memory** | 历史任务、故障模式、修复模式、项目约定 | 永久积累 | 越用越聪明 |

**关键机制**：文件指纹（SHA-256 + 结构签名）实现增量更新 — 日常任务可节省 80-95% 的 token。

---

## 4. 程序化 API 使用方式

### 4.1 基础用法

```typescript
import { CodeRepairAgent } from 'code-repair-agent';

// 1. 创建 Agent 实例
const agent = new CodeRepairAgent({
  verbose: true,
  provider: 'anthropic',        // 或 'openai' | 'moonshot' | 'deepseek' | 'zhipu' | 'template'
  model: 'claude-sonnet-4-6',   // 可选，使用 provider 默认模型
  tokenBudget: {
    total: 100000,
    analysis: 40000,
    planning: 30000,
    search: 20000,
    review: 10000,
  },
});

// 2. 初始化仓库（只需执行一次）
await agent.init('./my-project');

// 3. 执行修复任务
const plan = await agent.plan({
  id: 'task-1',
  description: 'Fix null pointer in auth module',
  type: 'bug',
  priority: 'high',
  context: {
    files: ['src/auth.ts'],
  },
});

// 4. 查看 Token 消耗
const budget = agent.getBudgetManager().getStatus();
console.log(`${budget.remaining}/${budget.total} tokens remaining`);
```

### 4.2 完整交互式修复流程

```typescript
// plan() 只生成方案，fix() 包含完整的 plan → patch → review → apply 流程
const result = await agent.fix({
  id: 'task-2',
  description: 'Fix memory leak in user service',
  type: 'bug',
  priority: 'high',
});
// 这会触发交互式 diff Review，用户确认后才应用 patch
```

### 4.3 批量任务

```typescript
import { batchTasks } from 'code-repair-agent';

await batchTasks(agent, [
  { id: 't1', description: 'Fix auth null pointer', type: 'bug', priority: 'high' },
  { id: 't2', description: 'Refactor user service', type: 'refactor', priority: 'medium' },
], { parallel: false, autoPush: false });
```

### 4.4 增量同步

```typescript
import { syncRepo } from 'code-repair-agent';

// 代码变更后，增量更新知识图谱（无需全量重新扫描）
const result = await syncRepo(agent.getMemory(), {
  repoPath: './my-project',
  forceFull: false,  // true 则强制全量重分析
});
```

---

## 5. CLI 命令速查

| 命令 | 作用 | 常用选项 |
|------|------|---------|
| `code-agent init [path]` | 扫描仓库，建立知识图谱 | — |
| `code-agent plan <desc>` | 仅生成修复方案 | `--provider`, `--model`, `--budget`, `--file`, `--web-search` |
| `code-agent fix <desc>` | 完整修复流程（交互式） | 同上 + `--auto-push` |
| `code-agent apply <plan-id>` | 应用已审核的方案 | `--dry-run` |
| `code-agent sync [path]` | 增量同步知识图谱 | `--force-full` |
| `code-agent status [path]` | 查看图谱统计 | — |
| `code-agent batch <json>` | 批量处理任务 | `--parallel`, `--auto-push` |
| `code-agent history` | 查看任务历史和模式 | — |
| `code-agent learn` | 学习项目约定 | — |
| `code-agent metrics` | 查看性能指标 | `--json`, `--reset` |

---

## 6. 配置说明

### 6.1 LLM Provider 配置

| Provider | 环境变量 | 默认模型 |
|----------|---------|---------|
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6-20251001` |
| OpenAI | `OPENAI_API_KEY` | `gpt-5.4` |
| Moonshot (Kimi) | `MOONSHOT_API_KEY` | `kimi-k2.5` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| Zhipu (GLM) | `ZHIPU_API_KEY` | `glm-5.1` |
| Template (模拟) | 无需 | 用于无 API key 测试 |

**配置优先级**：显式参数 > 环境变量 > `~/.code-agent/config.yaml` > Template 降级

### 6.2 Web Search 配置

| 方式 | 配置方法 |
|------|---------|
| 环境变量 | `export TAVILY_API_KEY=tvly-xxx` |
| 用户配置 | `~/.code-agent/config.yaml` → `tavily.apiKey` |
| Keyless 模式 | 无需配置，自动使用（有速率限制，超限时降级到 DuckDuckGo） |

### 6.3 配置文件示例（`~/.code-agent/config.yaml`）

```yaml
anthropic:
  apiKey: sk-ant-xxxxxxxx
  model: claude-opus-4-8

moonshot:
  apiKey: sk-xxxxxxxx

tavily:
  apiKey: tvly-xxxxxxxx
```

---

## 7. Web 应用集成要点

### 7.1 作为后端服务调用

```typescript
// server.ts — Express/Fastify/Elysia 等
import { CodeRepairAgent } from 'code-repair-agent';

const agent = new CodeRepairAgent({ provider: 'anthropic' });
await agent.init('/path/to/repo');

// POST /api/plan
app.post('/api/plan', async (req, res) => {
  const plan = await agent.plan(req.body);
  res.json(plan);
});
```

### 7.2 流式输出（建议）

Agent 流水线中的每个阶段（scan → detect → search → plan → patch）都会产生中间结果。Web 应用建议通过 **SSE (Server-Sent Events)** 或 **WebSocket** 流式推送进度，让用户看到实时分析过程，而非等待最终结果。

### 7.3 状态持久化

Agent 的 L1/L2/L3 记忆通过 `MemoryMiddleware` 自动持久化到 `.repair-agent/memory.json`。Web 应用可以通过 `agent.loadMemory()` / `agent.saveMemory()` 在请求间恢复状态。

### 7.4 多仓库支持

每个仓库有独立的 `.repair-agent/` 目录。Web 应用可以同时管理多个仓库，为每个仓库维护独立的 Agent 实例和记忆状态。

### 7.5 安全注意事项

- API key 永远不会暴露在响应中（自动脱敏：`sk-a****xxxx`）
- Git 操作默认创建 feature 分支，禁止直接修改 main/master
- Patch 应用前必须经过人工 Review（可配置 `--auto-push` 跳过，但不建议）

---

## 8. 技术栈

| 组件 | 技术 |
|------|------|
| 语言 | TypeScript 5.4+ (ESM) |
| 运行时 | Node.js ≥ 24 |
| 代码解析 | Tree-sitter (6 种语言) + 正则回退 |
| 测试 | vitest |
| CLI | Commander.js |
| 搜索 | Tavily (@tavily/core) + DuckDuckGo |
| LLM SDK | @anthropic-ai/sdk |
| 本地搜索 | fuse.js |
| 校验 | zod |

---

## 9. 参考文档

| 文档 | 内容 |
|------|------|
| `README.md` | 快速开始、功能概览 |
| `docs/API.md` | CLI 和程序化 API 完整参考 |
| `DESIGN.md` | 系统架构设计（v1.0.0） |
| `PROGRESS.md` | 实现进度和功能清单 |
| `CONTEXT.md` | 项目背景和设计决策 |

---

*本文档生成于 2026-06-03，基于 code-repair-agent v0.5.0。*
