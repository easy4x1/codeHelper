# Understand-Anything 深度分析 — 关键发现

> 分析对象: [Understand-Anything](https://github.com/Lum1104/Understand-Anything)
> 分析日期: 2026-05-28
> 分析版本: v2.7.5

---

## 1. 项目定位与核心能力

Understand-Anything 是一个**跨平台的 AI 编码助手插件**，核心能力是将任意代码库转换为可交互的知识图谱。它支持 Claude Code、Cursor、Copilot CLI、Gemini CLI 等 10+ 个平台。

### 1.1 核心产品能力

| 能力 | 说明 |
|------|------|
| **结构图谱** | 将代码库可视化成交互式知识图谱（文件、函数、类、依赖） |
| **业务域视图** | 将代码映射到业务领域（domains、flows、steps） |
| **知识库分析** | 分析 LLM Wiki（Karpathy 模式），提取实体和关系 |
| **引导式学习** | 自动生成架构学习路径 |
| **Diff 影响分析** | 分析代码变更的涟漪效应 |
| **模糊 + 语义搜索** | 支持按名称和含义搜索 |
| **自适应 UI** | 根据用户角色调整信息密度 |

---

## 2. 架构设计亮点

### 2.1 Tree-sitter + LLM 混合架构

这是 UA 最核心的设计决策：

| 层面 | 工具 | 职责 | 特性 |
|------|------|------|------|
| **确定性层** | Tree-sitter | 解析 AST，提取函数/类/导入/导出/调用关系 | 可复现、零 token、精确 |
| **语义层** | LLM Agent | 生成摘要、标签、架构分层、业务域映射 | 理解意图、有深度 |

**关键洞察**: 将"可复现的结构提取"和"需要理解的语义分析"分离，让 LLM 只做它最擅长的事。

### 2.2 多 Agent 协作流水线

UA 定义了 **7 个专用 Agent**，通过明确的阶段化流水线协作：

```
Phase 1 (SCAN)       → project-scanner    → 文件发现 + 语言检测 + Import 解析
Phase 1.5 (BATCH)    → compute-batches    → 基于依赖关系智能分 batch
Phase 2 (ANALYZE)    → file-analyzer x N  → 并行分析（最多 5 并发）
Phase 3 (ASSEMBLE)   → assemble-reviewer  → 跨 batch 边修复、去重
Phase 4 (ARCHITECTURE)→ architecture-analyzer → 自动识别架构分层
Phase 5 (TOUR)       → tour-builder       → 生成学习路径
Phase 6 (REVIEW)     → graph-reviewer     → 完整性校验
Phase 7 (SAVE)       → 保存 + fingerprint → 建立增量更新基线
```

**关键洞察**: Agent 不是越多越好，而是每个 Agent 职责单一、Prompt 精炼、输入输出标准化。

### 2.3 Agent 定义模式

UA 的 Agent 定义采用 **Markdown + YAML Frontmatter** 的标准格式：

```yaml
---
name: agent-name
description: |
  Agent 的简短描述
---

# Agent 名称

## Task
详细任务说明...

## Phase X
分阶段执行指南...

## Critical Constraints
关键约束...

## Output Format
输出格式规范...
```

**关键洞察**: Agent 定义与代码分离，便于迭代优化 Prompt，且可以被不同平台复用。

---

## 3. Token 优化机制（最值得借鉴）

### 3.1 Structural Fingerprinting（结构指纹）

UA 为每个文件维护一个结构指纹，包含：

```typescript
interface FileFingerprint {
  filePath: string;
  contentHash: string;           // SHA-256 完整内容哈希
  functions: FunctionFingerprint[];  // 函数签名（名、参数、返回值、导出状态、行数）
  classes: ClassFingerprint[];   // 类签名（名、方法、属性、导出状态、行数）
  imports: ImportFingerprint[];  // 导入签名（来源、导入项）
  exports: string[];             // 导出名称列表
  totalLines: number;
  hasStructuralAnalysis: boolean;
}
```

### 3.2 三级变更分类

| 级别 | 判定条件 | 处理方式 | Token 消耗 |
|------|---------|---------|-----------|
| **NONE** | 内容哈希完全相同 | 完全跳过 | **0** |
| **COSMETIC** | 内容变了，但函数/类/导入/导出签名未变 | 跳过 LLM 分析，仅更新元数据 | **0** |
| **STRUCTURAL** | 签名级变化（新增/删除函数、参数变化、导入变化等） | 重新分析该文件 | 中等 |

**关键洞察**: 日常开发中大部分提交是 COSMETIC（格式化、重构内部逻辑、改注释），这些提交在 UA 中**零 token 消耗**。

### 3.3 增量更新决策矩阵

```typescript
function classifyUpdate(analysis: ChangeAnalysis, totalFiles: number): UpdateDecision {
  const structuralCount = analysis.newFiles.length 
                        + analysis.deletedFiles.length 
                        + analysis.structurallyChangedFiles.length;

  if (structuralCount === 0) {
    return { action: "SKIP", reason: "No structural changes" };
  }
  
  if (structuralCount > 30 || structuralCount / totalFiles > 0.5) {
    return { action: "FULL_UPDATE", reason: "Too many structural changes" };
  }
  
  if (hasDirectoryChanges(analysis) || structuralCount > 10) {
    return { action: "ARCHITECTURE_UPDATE", reason: "Directory structure changed" };
  }
  
  return { action: "PARTIAL_UPDATE", reason: "Localized structural changes" };
}
```

### 3.4 预计算与缓存策略

| 预计算项 | 计算时机 | 复用方式 |
|----------|---------|---------|
| Import Map | Scan 阶段一次性计算 | 直接传递给所有 file-analyzer |
| Batch 划分 | Batch 阶段一次性计算 | 基于 import 关系的智能分组 |
| NeighborMap | Batch 阶段计算 | 为每个 batch 提供跨 batch 符号信息 |
| Fingerprint | 全量分析后保存 | 后续增量更新的基线 |

---

## 4. 知识图谱设计

### 4.1 节点类型（13 种）

| 类型 | 用途 | ID 格式 |
|------|------|---------|
| `file` | 源代码文件 | `file:<path>` |
| `function` | 函数/方法 | `function:<path>:<name>` |
| `class` | 类/接口 | `class:<path>:<name>` |
| `config` | 配置文件 | `config:<path>` |
| `document` | 文档 | `document:<path>` |
| `service` | 服务定义（Dockerfile 等） | `service:<path>` |
| `table` | 数据库表 | `table:<path>:<name>` |
| `endpoint` | API 端点 | `endpoint:<path>:<name>` |
| `pipeline` | CI/CD 配置 | `pipeline:<path>` |
| `schema` | Schema 定义 | `schema:<path>` |
| `resource` | 基础设施资源 | `resource:<path>` |
| `module` | 逻辑模块 | `module:<name>` |
| `concept` | 抽象概念 | `concept:<name>` |

### 4.2 边类型（26 种）

按类别组织：

| 类别 | 边类型 | 权重 |
|------|--------|------|
| **结构** | contains, imports, exports, inherits, implements | 0.7-1.0 |
| **行为** | calls, subscribes, publishes, middleware | 0.8 |
| **数据流** | reads_from, writes_to, transforms, validates | 0.5 |
| **依赖** | depends_on, tested_by, configures | 0.5-0.6 |
| **语义** | related, similar_to | 0.5 |
| **基础设施** | deploys, serves, provisions, triggers | 0.6-0.7 |
| **Schema** | migrates, documents, routes, defines_schema | 0.5-0.8 |

### 4.3 分层与游览

- **Layer**: 将节点分组到架构层（API、Service、Data、UI、Utility）
- **Tour**: 生成引导式学习路径，帮助新成员理解代码库

---

## 5. 增量更新机制

### 5.1 Auto-Update Hook

UA 通过 Hook 机制实现自动增量更新：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "git commit 检测 → 触发增量更新"
        }]
      }
    ],
    "SessionStart": [
      {
        "hooks": [{
          "type": "command", 
          "command": "检查 graph 是否过期 → 提示更新"
        }]
      }
    ]
  }
}
```

### 5.2 增量更新流程

```
Commit 触发 ──▶ 获取变更文件列表 ──▶ .understandignore 过滤
                                           │
                                           ▼
                              ┌────────────────────────┐
                              │   Fingerprint Check    │
                              │   (零 Token 成本)       │
                              └───────────┬────────────┘
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
                SKIP(跳过)          PARTIAL_UPDATE         ARCHITECTURE_UPDATE
                更新元数据          仅重分析变化文件          重分析 + 重分层
                    │                     │                     │
                    └─────────────────────┼─────────────────────┘
                                          │
                                          ▼
                              ┌────────────────────────┐
                              │   Merge with Existing  │
                              │   (加载-修补-保存)      │
                              └───────────┬────────────┘
                                          │
                                          ▼
                                    保存新图谱
```

### 5.3 Fingerprints 的加载-修补-保存模式

**关键发现**: UA 特别强调 fingerprints 的更新必须是 **LOAD-PATCH-SAVE** 而非 OVERWRITE：

```javascript
// 正确做法：加载所有已有指纹，只修补变化的部分
const all = JSON.parse(readFileSync(fpPath));  // 加载全部
for (const filePath of filesToReanalyze) {
  all[filePath] = computeFingerprint(filePath);  // 只修补变化的
}
writeFileSync(fpPath, JSON.stringify(all));  // 保存全部

// 错误做法：只保存本次分析的文件（会导致其他文件指纹丢失）
const batch = {};
for (const filePath of filesToReanalyze) {
  batch[filePath] = computeFingerprint(filePath);
}
writeFileSync(fpPath, JSON.stringify(batch));  // ❌ 丢失了其他文件的指纹
```

---

## 6. 搜索机制

### 6.1 本地搜索

UA 使用 **fuse.js** 实现模糊搜索：

```typescript
const FUSE_OPTIONS = {
  keys: [
    { name: "name", weight: 0.4 },
    { name: "tags", weight: 0.3 },
    { name: "summary", weight: 0.2 },
    { name: "languageNotes", weight: 0.1 },
  ],
  threshold: 0.4,
  includeScore: true,
  ignoreLocation: true,
  useExtendedSearch: true,
};
```

### 6.2 语义搜索

UA 也实现了基于余弦相似度的语义搜索：

```typescript
class SemanticSearchEngine {
  search(query: string, options?: SemanticSearchOptions): SearchResult[];
}

function cosineSimilarity(a: number[], b: number[]): number;
```

---

## 7. 可借鉴的设计模式

### 7.1 设计模式清单

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| **Agent 即配置** | Agent 定义为 Markdown 文件，非代码 | 快速迭代 Prompt，跨平台复用 |
| **确定性优先** | Tree-sitter 做结构，LLM 做语义 | 降低 token，提高可复现性 |
| **指纹增量** | 结构指纹 + 三级变更分类 | 日常任务零 token 消耗 |
| **预计算传递** | Import map 一次性计算，多 Agent 复用 | 避免重复解析 |
| **Neighbor 上下文** | 为每个 batch 提供跨 batch 符号信息 | 支持并行同时保持边准确性 |
| **标准化 I/O** | 每个 Agent 的输入输出都是标准化 JSON | 便于组合、测试、调试 |
| **LOAD-PATCH-SAVE** | 增量更新时加载全部、修补部分、保存全部 | 避免数据丢失 |
| **Hook 触发** | 通过平台 Hook 机制自动触发 | 自动化增量更新 |
| **图谱持久化** | 知识图谱保存为 JSON，可提交到 git | 团队共享，跳过重复构建 |

### 7.2 需要改进的点

| 方面 | UA 的现状 | 改进方向 |
|------|----------|---------|
| **故障修复** | 仅分析代码结构，不诊断问题 | 增加故障传播分析、根因定位 |
| **联网搜索** | 无联网能力 | 增加 Web Search 补充 |
| **代码修改** | 仅生成图谱，不修改代码 | 增加 Patch 生成、自动应用 |
| **Review 流程** | 无人工审核环节 | 增加 Review 界面、安全网 |
| **学习进化** | 无跨任务学习 | 增加模式提取、经验复用 |

---

## 8. 核心文件清单

### 8.1 关键源文件

| 文件 | 职责 |
|------|------|
| `src/search.ts` | fuse.js 模糊搜索实现 |
| `src/fingerprint.ts` | 结构指纹 + 变更分类 |
| `src/change-classifier.ts` | 增量更新决策矩阵 |
| `src/types.ts` | 知识图谱类型定义 |
| `src/index.ts` | 核心模块导出 |
| `src/context-builder.ts` | 聊天上下文构建 |
| `src/understand-chat.ts` | 聊天 Prompt 构建 |

### 8.2 关键 Agent 定义

| 文件 | 职责 |
|------|------|
| `agents/project-scanner.md` | 仓库扫描 Agent |
| `agents/file-analyzer.md` | 文件分析 Agent |
| `agents/architecture-analyzer.md` | 架构分层 Agent |
| `agents/tour-builder.md` | 学习路径 Agent |
| `agents/graph-reviewer.md` | 图谱校验 Agent |
| `agents/assemble-reviewer.md` | 跨 batch 审查 Agent |
| `agents/domain-analyzer.md` | 业务域分析 Agent |

### 8.3 关键脚本

| 文件 | 职责 |
|------|------|
| `scan-project.mjs` | 文件扫描 + 语言检测 |
| `extract-import-map.mjs` | Import 解析 |
| `extract-structure.mjs` | 结构提取（Tree-sitter） |
| `compute-batches.mjs` | 智能 batch 划分 |
| `merge-batch-graphs.py` | Batch 结果合并 |
| `build-fingerprints.mjs` | 指纹基线构建 |

---

## 9. 总结

Understand-Anything 的核心价值在于：

1. **将 LLM 视为"语义层"而非"全能层"** — 结构提取用 Tree-sitter，LLM 只做摘要和分层
2. **通过 Fingerprint 实现日常任务的零 token 消耗** — 这是最具工程价值的创新
3. **Agent 职责单一、接口标准化** — 便于并行、测试、迭代
4. **知识图谱持久化** — 一次分析，团队共享，支持增量更新

这些设计思想完全可以迁移到故障修复场景，且故障修复场景还有额外的优化空间（故障传播裁剪、模式复用、搜索补充等）。
