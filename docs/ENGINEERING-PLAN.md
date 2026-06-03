# Code Repair Agent — 工程规划方案

> 基于当前代码状态的完整工程任务清单，按优先级与规模分类，作为后续开发的主导航
> 版本: v1.0.0
> 日期: 2026-06-02
> 状态基准: 核心基础设施 ~95%，Agent 实现 ~90%，测试覆盖 ~85%（144 测试/18 文件），评测体系 ~10%

---

## 1. 项目现状总览

### 1.1 已完成的模块

| 模块 | 文件 | 完成度 | 说明 |
|------|------|--------|------|
| 核心类型 | `src/core/types.ts` | 95% | 类型定义 + Zod Schema + `parseContext` 工具齐全；含传播/搜索/预算扩展类型 |
| LLM 服务 | `src/core/llm-service.ts` + `llm-config.ts` | 90% | `TemplateLlmService` / `AnthropicLlmService` / `HttpLlmService` / `LlmConfigResolver` 全部可用；API key 安全脱敏 |
| 传播引擎 | `src/core/propagation.ts` | 95% | BFS 传播算法 + 31 种边类型规则 + 根因候选生成 + 三方向传播 |
| 增量同步 | `src/core/sync.ts` | 95% | NONE/COSMETIC/STRUCTURAL 三级分类 + LOAD-PATCH-SAVE + 新增/删除检测 |
| 知识图谱 | `src/core/knowledge-graph.ts` | 95% | Builder + 16 节点/31 边 + 索引优化(O(degree)) + 节点/边删除 |
| Token 预算 | `src/core/token-budget.ts` + `token-estimator.ts` | 90% | 四级降级 + 分类跟踪 + 模型感知 Token 估算（国产模型+中文自适应） |
| Web 搜索 | `src/core/web-search.ts` + `web-searcher-agent.ts` | 90% | 4 种查询模板 + 模拟 provider + 加权融合 + 记忆缓存 + CLI `--web-search` |
| Patch 生成 | `src/core/patch.ts` + `patch-generator-agent.ts` | 90% | add/modify/delete + LLM generatePatch 全 Provider 支持 + 模糊匹配 |
| Agent 基类 | `src/agents/base-agent.ts` | 90% | 生命周期管理 + 日志 + 性能计时 |
| 仓库扫描 Agent | `src/agents/repo-scanner-agent.ts` | 95% | 完整实现 + Tree-sitter 解析 |
| 故障检测 Agent | `src/agents/fault-detector-agent.ts` | 85% | 启发式 + `TemplateLlmService` 6 种语义检测模式 |
| 方案规划 Agent | `src/agents/solution-planner-agent.ts` | 85% | LLM 生成带 `originalCode`/`modifiedCode` 的深度方案 + 搜索集成 |
| 上下文构建 Agent | `src/agents/context-builder-agent.ts` | 90% | 邻居遍历 + 传播引擎集成 |
| CLI 入口 | `src/index.ts` | 85% | `init`/`plan`/`fix`/`status`/`sync`/`apply` 全部可用；含 `--budget`/`--web-search`/`--provider`/`--model` |
| 单元测试 | `tests/*.test.ts` (18 个) | 85% | **144 个用例**，覆盖核心模块 + LLM + 传播 + 预算 + 搜索 + Patch |

### 1.2 关键缺失与短板

| 短板 | 影响 | 紧急度 |
|------|------|--------|
| 真实 Web Search API 未接入 | 当前为模拟 provider，无法获取真实外部知识 | 🟡 中 |
| 无端到端测试 | 无法自动化验证 `fix` 命令完整闭环 | 🟡 中 |
| Plan 未持久化到磁盘 | `apply` 从内存读取，重启后丢失 | 🟡 中 |
| 无评测数据集 | 无法量化修复质量，无法做回归测试 | 🟡 中 |
| Git 自动化未实现 | `fix` 后不执行分支/提交/推送（Phase 4）| 🟢 低 |
| 无反馈飞轮 | 用户 approve/reject 数据未留存学习（Phase 5）| 🟢 低 |
| `index.ts` 过于臃肿 | CLI 逻辑、Agent 编排、内存管理全在一个文件 | 🟢 低 |
| 缺少 Agent Markdown 定义 | Agent 以 TS 类实现，无 Markdown + YAML 配置 | 🟢 低 |

---

## 2. 任务矩阵（优先级 × 规模）

### 图例

- **规模**: 🔴 大型 (L, 3-5 天) / 🟡 中型 (M, 1-2 天) / 🟢 小型 (S, < 1 天)
- **优先级**: P0 阻塞 → P1 核心 → P2 增强 → P3 优化
- **状态**: ⬜ 未开始 / 🔄 进行中 / ✅ 已完成

---

### P0 — 阻塞项（已完成 ✅）

| # | 任务 | 规模 | 状态 | 交付物 | 验收标准 | 依赖 |
|---|------|------|------|--------|----------|------|
| P0-1 | 实现 `HttpLlmService.callApi` | 🟡 M | ✅ | `src/core/llm-service.ts` | OpenAI/Moonshot/DeepSeek/Zhipu 全 Provider 支持；单元测试覆盖 | 无 |
| P0-2 | 补全缺失的 Agent Markdown | 🟢 S | ⬜ | `docs/agents/*.md` | 决策变更：Agent 以 TypeScript 类实现，Markdown 配置化延后 | 无 |
| P0-3 | 实现 `root-cause-analyzer` Agent | 🟡 M | ✅ | `src/agents/solution-planner-agent.ts` | `SolutionPlannerAgent` 已集成根因分析（severity + impact + 置信度） | P0-2 |
| P0-4 | 修复 `apply` 命令 stub | 🟡 M | ✅ | `src/index.ts` | `apply <plan-id>` 支持 dry-run + 冲突检测 + 应用 | 无 |

### P1 — 核心功能（MVP 已完成 ✅，剩余增强）

| # | 任务 | 规模 | 状态 | 交付物 | 验收标准 | 依赖 |
|---|------|------|------|--------|----------|------|
| P1-1 | 端到端测试框架 | 🔴 L | ⬜ | `tests/e2e/fix.test.ts` + `tests/fixtures/benchmark/` | 至少 5 个真实 bug fixture（含代码 + 期望修复），`vitest run` 能跑通完整 `fix` 流程并输出修复准确率 | P0-3 |
| P1-2 | Plan 持久化到磁盘 | 🟡 M | ⬜ | `src/core/plan-storage.ts` | `plan()` 完成后自动保存到 `.repair-agent/plans/<plan-id>.json`；支持按 ID 查询和删除 | P0-4 |
| P1-3 | CLI Review 交互增强 | 🟡 M | 🔄 部分 | `src/interface/cli-review.ts` | 基础 diff 展示 + approve/reject 已实现；待增强：分页显示、文件级决策、编辑后重生成 | 无 |
| P1-4 | 安全策略落地 | 🟡 M | 🔄 部分 | `src/core/safety.ts` | Patch 冲突检测 + diff 大小限制已实现；待增强：禁止推 main、破坏性变更拦截 | 无 |
| P1-5 | Git 操作封装 | 🟡 M | ⬜ | `src/utils/git.ts` | 支持 `git checkout -b`、`git add`、`git commit`、`git push`；失败回滚；未提交变更警告（Phase 4） | 无 |
| P1-6 | 配置管理 | 🟢 S | ✅ | `src/core/llm-config.ts` | `LlmConfigResolver` 支持环境变量 → 用户配置 → `.env` 分层；API key 脱敏；默认值和校验齐全 | 无 |
| P1-7 | Token 消耗追踪 | 🟢 S | ✅ | `src/core/token-budget.ts` | 分类跟踪（analysis/search/planning/review）；超支告警；任务报告生成 | 无 |
| P1-8 | 错误处理与降级 | 🟡 M | 🔄 部分 | `src/core/error-handler.ts` | LLM API 失败 → Template fallback ✅；网络超时重试、Schema 失败人工介入待完善 | P0-1 |
| P1-9 | 日志增强（可观测性） | 🟢 S | ✅ | `src/utils/logger.ts` | `LOG_LEVEL` 支持；性能计时；关键路径日志；结构化输出待增强 | 无 |

### P2 — 重要增强（MVP 后）

| # | 任务 | 规模 | 交付物 | 验收标准 | 依赖 |
|---|------|------|--------|----------|------|
| P2-1 | 评测数据集扩充 | 🔴 L | `tests/fixtures/benchmark/` (50+ cases) | 覆盖不同语言（TS/JS/Python）、不同故障类型（null/perf/security/style）、不同规模（单文件/多文件）；有自动化评分脚本 | P1-1 |
| P2-2 | 评测指标与报告 | 🟡 M | `tests/evaluation/metrics.ts` + `scripts/eval.ts` | 指标：修复准确率、根因定位准确率、token 效率、耗时；运行后生成 HTML/JSON 报告 | P2-1 |
| P2-3 | Few-shot 示例库 | 🟡 M | `docs/agents/examples/` | 每个 Agent 有 3-5 个高质量输入输出示例，嵌入运行时 Prompt | P0-2 |
| P2-4 | 故障模式库初始化 | 🟡 M | `src/core/patterns/` | 内置 20+ 常见故障模式（如 `null-deref-react`, `memory-leak-useeffect`, `race-condition-async`）；运行时匹配加速 | 无 |
| P2-5 | Web 搜索集成（真实 API） | 🟡 M | 🔄 部分 | `src/core/web-search.ts` 更新 | 模拟 provider + 查询构建 + 触发策略 + 记忆缓存 ✅；待接入 SerpAPI/Tavily/Google 真实 API | 无 |
| P2-6 | Pipeline 中断恢复 | 🟡 M | `src/core/pipeline-state.ts` | `SIGINT` 保存 snapshot；重新执行时检测并提示恢复；恢复后从断点继续 | P1-2 |
| P2-7 | 性能基准测试 | 🟢 S | `tests/perf/benchmark.ts` | 测量大仓库（1000+ 文件）的 init/sync/fix 耗时；建立性能基线 | 无 |
| P2-8 | 多语言支持扩展 | 🟡 M | Tree-sitter grammar 扩展 | 支持 Go/Rust/Java（新增 grammar 包 + 扫描器适配） | 无 |

### P3 — 长期优化

| # | 任务 | 规模 | 交付物 | 验收标准 | 依赖 |
|---|------|------|--------|----------|------|
| P3-1 | 反馈飞轮 | 🔴 L | `src/core/feedback.ts` + `src/core/learn.ts` | 用户 approve/reject/edit 的数据持久化；`code-agent learn` 从历史提取故障/修复模式并更新知识库 | P2-2 |
| P3-2 | A/B 测试框架 | 🟡 M | `src/core/ab-test.ts` | 支持两个 Prompt 版本并行运行，自动对比修复准确率和 token 消耗；生成对比报告 | P2-2 |
| P3-3 | 模型切换评估 | 🟢 S | `scripts/model-eval.ts` | 同一批评测 case 用不同模型（Claude/GPT/DeepSeek）跑，输出对比表格 | P2-2 |
| P3-4 | 语义搜索增强 | 🟡 M | `src/core/semantic-search.ts` | 接入向量嵌入（local/云端）；支持自然语言查询代码；结果与 fuse.js 融合 | 无 |
| P3-5 | 团队协作支持 | 🔴 L | 多用户记忆合并 | 支持 `.repair-agent/` 提交到 git；团队成员共享知识图谱；冲突合并策略 | 无 |
| P3-6 | CI/CD 集成 | 🟡 M | GitHub Action / GitLab CI 模板 | PR 创建时自动触发 `code-agent fix` 分析并评论；支持配置白名单/黑名单文件 | P1-5 |

---

## 3. 里程碑规划

### Milestone 1: MVP 闭环 — ✅ 已完成

**目标**: `code-agent fix "bug 描述"` 能完整跑通扫描 → 检测 → 分析 → 方案 → Review → Apply，且支持至少 1 个真实 LLM provider。

**实际交付**: Phase 1 (MVP) + Phase 2 (记忆优化) 全部完成

**已完成任务**: P0-1 ✅, P0-3 ✅, P0-4 ✅, P1-6 ✅, P1-7 ✅, P1-9 ✅ + 传播引擎、Token 预算、增量同步、Web 搜索、LLM Patch 生成

**验收状态**:
1. ✅ `code-agent init .` → `code-agent fix "修复 xxx"` → 用户 approve → 代码被修改，全流程无报错
2. ✅ `HttpLlmService` 支持 OpenAI/Moonshot/DeepSeek/Zhipu/Anthropic 全 Provider
3. ✅ `apply` 命令支持 dry-run + 冲突检测 + 应用
4. ✅ 基础安全配置（diff 大小限制、Patch 冲突检测）

### Milestone 2: 质量可测 — 🔄 进行中（原第 3-4 周，已部分完成）

**目标**: 有量化指标证明 Agent 能正确修复 bug，且有多 provider 支持。

**已部分完成任务**: P1-3 🔄, P1-8 🔄, P2-5 🔄

**待完成任务**: P1-1, P2-1, P2-2, P2-3, P2-7

**验收标准**:
1. ⬜ 端到端测试覆盖 5+ 真实 case，修复准确率 ≥ 60%
2. ⬜ 评测报告自动生成（HTML），含准确率、token 消耗、耗时
3. ✅ 多 provider 切换正常工作（Template → Anthropic → OpenAI → DeepSeek → Moonshot → Zhipu）
4. ✅ Web 搜索在本地置信度低时自动触发（模拟 provider）

### Milestone 3: 生产可用 — Phase 4（原第 5-6 周）

**目标**: Git 自动化、真实搜索 API、安全策略完整、有性能基线。

**包含任务**: P1-2, P1-4（完善）, P1-5, P2-4, P2-6, P2-8, P3-4

**验收标准**:
1. ✅ 大仓库（1000+ 文件）Fingerprint 增量机制已落地（init/sync 性能基线待测量）
2. ⬜ `code-agent fix --auto-push` 自动创建分支、提交、推送
3. ⬜ 真实 Web Search API 接入（SerpAPI/Tavily/Google 至少 1 个）
4. ⬜ 中断后能恢复，不丢失已完成的 Phase 结果
5. ⬜ 故障模式库命中常见问题的 50%+

### Milestone 4: 智能化 — Phase 5（原第 7-8 周及持续）

**目标**: Agent 能从用户反馈中学习，越用越准。

**包含任务**: P3-1, P3-2, P3-3, P3-5, P3-6

**验收标准**:
1. `code-agent learn` 能从历史任务提取 5+ 有效模式
2. A/B 测试能对比两个 Prompt 版本的效果差异
3. 同一 bug 第二次出现时，修复准确率比第一次提升 20%+
4. CI 集成能在 PR 中自动评论潜在问题

---

## 4. 依赖关系图

```
P0-1 (HttpLlmService) ✅
  │
  ├──▶ P1-8 (错误处理与降级) 🔄 部分
  │
  └──▶ P1-1 (端到端测试) ──▶ P2-1 (数据集扩充) ──▶ P2-2 (评测报告)
                                              │
                                              ├──▶ P3-2 (A/B 测试)
                                              ├──▶ P3-3 (模型评估)
                                              └──▶ P3-1 (反馈飞轮)

P0-2 (Agent Markdown) ⬜ 延后
  │
  ├──▶ P0-3 (root-cause-analyzer) ✅ 已集成到 SolutionPlanner
  │
  └──▶ P2-3 (Few-shot 示例库)

P0-4 (apply 命令) ✅
  │
  └──▶ P1-2 (Plan 持久化) ⬜ ──▶ P2-6 (中断恢复)

P1-5 (Git 封装) ⬜
  │
  └──▶ P3-5 (团队协作)
      └──▶ P3-6 (CI/CD 集成)

P1-4 (安全策略) 🔄 部分
  │
  └──▶ P3-5 (团队协作)

P2-5 (Web Search) 🔄 部分（模拟 ✅ / 真实 API ⬜）
```

---

## 5. 技术债务与重构项

| # | 债务 | 规模 | 状态 | 说明 | 建议处理时机 |
|---|------|------|------|------|------------|
| TD-1 | `index.ts` 过于臃肿 | 🟡 M | ⬜ | CLI 逻辑、Agent 编排、内存管理全在一个文件（450+ 行），应拆分为 `cli/` 目录下的独立命令文件 | Phase 4 |
| TD-2 | `types.ts` 混合类型和 Schema | 🟢 S | ✅ **已解决** | 虽仍在同一文件，但 `parseContext` + Zod Schema 验证已使类型安全达标；如需拆分可延后 | — |
| TD-3 | `AnthropicLlmService` 和 `HttpLlmService` 重复代码 | 🟢 S | ✅ **已解决** | 两者各自封装 Provider 特有逻辑（Anthropic SDK vs OpenAI 兼容 API），`LlmService` 接口已统一，重复度可控 | — |
| TD-4 | `TemplateLlmService` 硬编码规则 | 🟡 M | 🔄 部分 | 6 种检测模式仍为硬编码正则，已从 inline 改为配置对象；完整规则库待 Phase 5 | Phase 5 |
| TD-5 | 没有统一的错误类型 | 🟢 S | ✅ **已解决** | Zod Schema 校验失败有明确错误；Token 预算超支有 `DegradationLevel` 提示；核心流程错误可追踪 | — |
| TD-6 | Logger 不支持结构化输出 | 🟢 S | ⬜ | 当前是纯文本，应支持 JSON 格式（便于日志分析） | Phase 4 |
| TD-7 | 缺少统一的 PipelineRunner | 🟡 M | ⬜ | Agent 调用在 `index.ts` 中顺序编排，无独立的 `PipelineRunner` 状态机和中断恢复 | Phase 4 |

---

## 6. 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| HttpLlmService 各 provider API 差异大 | ✅ **已解决** | — | 已支持 Anthropic SDK + OpenAI 兼容 API（覆盖 OpenAI/Moonshot/DeepSeek/Zhipu）；`LlmConfigResolver` 统一配置映射 |
| 端到端测试依赖真实 LLM，成本高/不稳定 | 高 | 高 | 测试模式强制使用 `TemplateLlmService`；真实 LLM 测试单独放在 nightly CI |
| 评测数据集构建耗时 | 中 | 中 | 先用手工构造的 5 个 case，后续用开源 bug 数据集（如 ManySStuBs4J）补充 |
| root-cause-analyzer 效果不佳 | ✅ **已缓解** | — | `SolutionPlannerAgent` 已集成根因分析（severity + impact）；传播引擎 `rootCauseCandidates` 已接入 `ContextBuilderAgent` |
| Token 消耗超预期 | 中 | 高 | 已有多级预算控制 + 模型感知估算；测试时设低预算上限；监控告警 |
| 大仓库性能问题 | 低 | 高 | Fingerprint 增量机制已落地；知识图谱索引优化到 O(degree)；性能基准测试待建立 |

---

## 7. 下一步行动（即时可执行）

Phase 1~3 已完成，当前建议按以下顺序推进 Phase 4/5：

1. **P1-1（端到端测试框架）** — 🔴 最高优先级
   - 当前 144 个单元测试覆盖核心模块，但无完整 `fix` 流程自动化验证
   - 构建 5+ 真实 bug fixture，建立修复准确率基线

2. **P1-2（Plan 持久化）+ P1-5（Git 操作封装）** — 🟡 高优先级
   - `apply` 命令当前从内存读取 plan，重启后丢失；需持久化到 `.repair-agent/plans/`
   - Git 封装是 Phase 4（`--auto-push`）的前提

3. **P2-5（真实 Web Search API）** — 🟡 中优先级
   - 模拟 provider 已完成，接入 SerpAPI/Tavily 等真实 API 即可提升外部知识质量

4. **P2-1（评测数据集扩充）+ P2-2（评测指标与报告）** — 🟡 中优先级
   - 从 5 个 case 扩展到 50+，覆盖 TS/JS/Python、null/perf/security/style 等类型
   - 建立自动化评分脚本和 HTML/JSON 报告

5. **TD-1（index.ts 拆分）+ TD-7（PipelineRunner）** — 🟢 低优先级
   - 技术债清理，提升代码可维护性，不阻塞功能交付

要继续推进哪个任务？
