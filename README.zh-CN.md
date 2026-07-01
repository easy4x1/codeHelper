# Code Repair Agent

[English](./README.md) · **简体中文**

> 基于指纹增量分析与多 Provider LLM 支持的 AI 代码修复 Agent。

[![Tests](https://img.shields.io/badge/tests-354%2F354%20passing-brightgreen)](#开发)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24.0-green)](https://nodejs.org/)

Code Repair Agent 是一个用于自动化代码修复的结构化多 Agent 流水线。它将确定性静态分析（Tree-sitter 解析、结构指纹）与基于 LLM 的语义推理相结合，在不牺牲准确度的前提下最大限度降低 token 消耗。每一处改动在进入仓库前都会经过人工审核闸门。

## 特性

- **混合代码分析** —— 通过 Tree-sitter + LLM 架构完成仓库扫描、知识图谱构建与故障检测，覆盖六种语言。
- **三层记忆** —— 仓库级静态（L1）、任务级动态（L2）、跨任务学习（L3）三层记忆，全部自动持久化。
- **增量分析** —— 结构指纹跳过未变更文件，增量任务上节省 80–95% token。
- **故障传播** —— 概率加权 BFS 遍历沿调用链追踪影响范围，裁剪分析集。
- **Token 预算控制** —— 四级降级阶梯（降低深度 → 禁用搜索 → 仅核心 → 提示用户）强制执行可配置预算。
- **多 Provider LLM** —— 支持 Anthropic、OpenAI、Moonshot（Kimi）、DeepSeek、Zhipu（GLM），含模型感知的 token 估算与自动降级。
- **联网搜索** —— 以 Tavily 为主力 Provider（免密钥或 API key），并提供 DuckDuckGo 与模拟降级链及结果缓存。
- **知识图谱增强** —— 在确定性核心图谱之上分层做语义增强（A：静态，B：框架感知，C：Embedding，D：LLM）。
- **Git 自动化** —— 自动创建分支、提交、推送，并由保护分支与 pre-commit 安全检查兜底。
- **可观测性** —— 内置指标：Agent 耗时、token 用量、缓存命中率、解析器覆盖率。
- **持续学习** —— 提取故障/修复模式、学习项目约定、推荐历史解决方案。
- **安全审核流程** —— 分层解析 API key 并在日志中脱敏，任何改动应用前均经人工 diff 审核。

## 快速开始

### 安装

```bash
# 克隆仓库
git clone <repo-url>
cd code-repair-agent

# 安装依赖
npm install

# 构建
npm run build

# 链接为全局 CLI
npm link
```

### 配置

#### LLM API 密钥

推荐通过环境变量设置：

```bash
# Anthropic (Claude)
export ANTHROPIC_API_KEY=sk-ant-...

# Moonshot (Kimi)
export MOONSHOT_API_KEY=sk-...

# DeepSeek
export DEEPSEEK_API_KEY=sk-...

# Zhipu (GLM)
export ZHIPU_API_KEY=...
```

或创建 `.env` 文件（已在 `.gitignore` 中）：

```bash
cp .env.example .env
# 编辑 .env 填入你的密钥
```

#### 联网搜索 (Tavily)

Tavily 是主力搜索 Provider。默认以**免密钥模式**工作（无需配置），也可提供 API key 以获得更高速率限制：

```bash
# 通过环境变量
export TAVILY_API_KEY=tvly-xxxxxxxxxxxxxxxx

# 或用户配置文件 (~/.code-agent/config.yaml)
tavily:
  apiKey: tvly-xxxxxxxxxxxxxxxx
```

在 [tavily.com](https://tavily.com) 免费获取 API key。触发速率限制时会自动降级为 DuckDuckGo → 模拟搜索。

#### Embedding（C 层图谱增强）

可选的 C 层使用本地 ONNX 模型（零 token）添加 `similar_to`/`related` 边与 `concept` 聚类。一条命令即可下载（约 34MB，存入 `./models`，已 git-ignore）：

```bash
npm run setup:embeddings    # 每台机器下载一次模型
code-agent init <repo> --embeddings local   # 自动探测 ./models，无需环境变量
```

受限网络下脚本会走镜像；踩坑、配置及 CI/Docker 说明见 [docs/EMBEDDING-SETUP.md](docs/EMBEDDING-SETUP.md)。

### 初始化仓库

```bash
code-agent init ./my-project
```

该命令扫描仓库、构建知识图谱，并将指纹持久化到 `.repair-agent/memory.json`。

### 分析与修复

```bash
# 交互式修复（plan → patch → review → apply）
code-agent fix "Fix memory leak in user service" --provider anthropic --model claude-sonnet-4-6

# 仅生成方案
code-agent plan "Refactor auth module" --provider moonshot --model kimi-k2.5

# 应用已审核的方案
code-agent apply plan-123

# 关闭联网搜索，仅本地分析
code-agent plan "Fix null pointer" --no-web-search

# 查看项目指标
code-agent metrics

# 查看任务历史
code-agent history

# 学习项目约定
code-agent learn
```

### 增量同步

代码变更后，增量更新知识图谱：

```bash
code-agent sync ./my-project
```

## CLI 命令

| 命令 | 说明 | 选项 |
|------|------|------|
| `init [repo-path]` | 扫描仓库并构建知识图谱 | `--embeddings [provider]`、`--semantic` |
| `plan <description>` | 仅生成修复方案 | `--provider`、`--model`、`--budget`、`--file`、`--web-search` |
| `fix <description>` | 完整交互式修复流程 | `--provider`、`--model`、`--budget`、`--auto-push`、`--file`、`--web-search`、`--create-pr` |
| `apply <plan-id>` | 非交互式应用已审核方案 | `--dry-run` |
| `sync [repo-path]` | 代码变更后增量同步 | `--force-full`、`--embeddings [provider]`、`--semantic` |
| `status [repo-path]` | 显示知识图谱统计 | — |
| `batch <tasks.json>` | 批量处理多个修复任务 | `--provider`、`--model`、`--budget`、`--auto-push`、`--web-search`、`--parallel` |
| `history` | 查看任务历史、模式、约定 | `--patterns`、`--conventions` |
| `learn [repo-path]` | 从代码库学习项目约定 | — |
| `metrics` | 显示性能指标与统计 | `--json`、`--reset` |

## 支持的 LLM Provider

| Provider | 模型示例 | 环境变量 |
|----------|---------|---------|
| **Anthropic** | `claude-sonnet-4-6`、`claude-opus-4-8` | `ANTHROPIC_API_KEY` |
| **OpenAI** | `gpt-5.4`、`gpt-5.5`、`gpt-4o` | `OPENAI_API_KEY` |
| **Moonshot (Kimi)** | `kimi-k2.5`、`kimi-k2.6` | `MOONSHOT_API_KEY` |
| **DeepSeek** | `deepseek-chat`、`deepseek-coder` | `DEEPSEEK_API_KEY` |
| **Zhipu (GLM)** | `glm-5.1` | `ZHIPU_API_KEY` |
| **Template**（模拟） | — | 无 |

`plan`、`fix`、`batch` 均以一致的 `--provider <name>` 与 `--model <name>` 选择厂商与模型。省略时，厂商会从环境变量中的 API key 自动探测，模型回退到该厂商的默认值。（`--llm` 保留为 `--provider` 的已弃用别名。）

## 架构

```
用户输入 → 任务规划 → 仓库扫描 → 知识图谱
                             ↓
                   记忆中间层 (L1/L2/L3)
                             ↓
        故障检测 → 上下文构建 → 联网搜索
                             ↓
        根因分析 → 方案规划 → 补丁生成
                             ↓
                  审核界面 → Git 执行
                             ↓
              学习 Agent（模式 + 约定）
```

详细架构文档见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 开发

```bash
# 运行测试
npm test

# 单次运行测试（CI）
npm run test:run

# 监听模式
npm run dev
```

## 许可证

MIT
