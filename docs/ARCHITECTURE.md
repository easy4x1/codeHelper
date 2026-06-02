# Architecture

> Detailed system architecture of Code Repair Agent

---

## 1. Overview

Code Repair Agent uses a **multi-agent pipeline** architecture inspired by Understand-Anything. The system separates deterministic work (Tree-sitter parsing, fingerprint comparison) from semantic work (LLM analysis, solution generation), minimizing token consumption while maximizing accuracy.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CLI / Programmatic API                        │
├─────────────────────────────────────────────────────────────────────┤
│  CodeRepairAgent                                                    │
│  ├── plan()    → generate repair plan                               │
│  ├── fix()     → full interactive repair flow                       │
│  ├── apply()   → apply approved patches                             │
│  ├── init()    → scan repo, build graph                             │
│  └── sync()    → incremental update                                 │
├─────────────────────────────────────────────────────────────────────┤
│  Agent Pipeline                                                      │
│  Scanner → Detector → Context Builder → Planner → Patch Generator   │
├─────────────────────────────────────────────────────────────────────┤
│  Core Modules                                                        │
│  ├── Knowledge Graph    (nodes + edges + indexes)                   │
│  ├── Fingerprint        (SHA-256 + structural signatures)           │
│  ├── Propagation Engine (BFS probability decay)                     │
│  ├── Token Budget       (tracking + degradation)                    │
│  ├── Token Estimator    (model-aware chars/token ratios)            │
│  └── Memory             (L1/L2/L3 layers)                           │
├─────────────────────────────────────────────────────────────────────┤
│  LLM Services                                                        │
│  ├── AnthropicLlmService  (Claude via SDK)                         │
│  ├── HttpLlmService       (OpenAI-compatible: GPT/Kimi/DS/GLM)     │
│  └── TemplateLlmService   (heuristic fallback)                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Core Modules

### 2.1 Knowledge Graph (`src/core/knowledge-graph.ts`)

Indexed graph data structure with O(1) edge lookups:

- **16 node types**: file, function, class, module, concept, config, document, service, table, endpoint, pipeline, schema, resource, fault, fix, pattern
- **31 edge types**: contains, imports, exports, inherits, implements, calls, subscribes, publishes, middleware, reads_from, writes_to, transforms, validates, depends_on, tested_by, configures, related, similar_to, deploys, serves, provisions, triggers, migrates, documents, routes, defines_schema, fixes, mitigates, relates_to_fault, suggests, learned_from
- **Indexes**: `nodesByType`, `edgesBySource`, `edgesByTarget` — neighbor queries O(degree) instead of O(n²)
- **Operations**: addNode, addEdge, removeNode (auto-cleans orphan edges), removeEdge, findNeighbors, mergeGraphs

### 2.2 Fingerprint (`src/core/fingerprint.ts`)

Structural signature for incremental analysis:

```typescript
interface FileFingerprint {
  filePath: string;
  contentHash: string;        // SHA-256
  functions: FunctionSignature[];   // name, params, returnType, lines
  classes: ClassSignature[];        // name, methods, properties, lines
  imports: ImportSignature[];       // source, items, isDefault
  exports: ExportSignature[];       // name, type, line
  totalLines: number;
}
```

**Tree-sitter integration**: Supports TypeScript, TSX, JavaScript, JSX, Python. Falls back to regex for unsupported languages.

**Change classification**:

| Level | Condition | Action | Token Cost |
|-------|-----------|--------|------------|
| NONE | contentHash identical | Skip entirely | 0 |
| COSMETIC | content changed, signatures unchanged | Update hash only | 0 |
| STRUCTURAL | signatures changed | Reanalyze file | Medium |

### 2.3 Propagation Engine (`src/core/propagation.ts`)

Fault impact analysis via weighted BFS:

```typescript
engine.trace(entryPoints, {
  direction: 'upstream' | 'downstream' | 'both',
  maxDepth: 3,
  minEdgeWeight: 0.5,
  includeTests: false,
});
```

**Propagation rules** (selected):

| Edge | Direction | Weight | Semantics |
|------|-----------|--------|-----------|
| calls | target→source | 0.8 | Caller affected by callee fault |
| contains | source→target | 1.0 | Parent affects child |
| imports | target→source | 0.7 | Importer affected by imported module |
| inherits | target→source | 0.9 | Child affected by parent class |

**Probability formula**: `P(node) = max(P(parent) × edge_weight)` across all paths. Multi-path nodes take the maximum probability.

### 2.4 Token Budget (`src/core/token-budget.ts`)

Four-level degradation triggered by usage fraction:

| Usage | Level | Action |
|-------|-------|--------|
| ≥70% | reduce_depth | maxPropagationDepth: 3 → 2 |
| ≥80% | disable_search | Disable web search |
| ≥90% | core_only | maxDepth: 1, maxFiles: 3 |
| ≥95% | prompt_user | Halt, ask user |

### 2.5 Token Estimator (`src/core/token-estimator.ts`)

Model-aware token counting with Chinese adaptation:

```typescript
const estimator = new ModelAwareTokenEstimator('kimi-k2.5');
estimator.estimate(code); // Adjusts ratio based on CJK character density
```

Domestic models (GLM/Kimi/DeepSeek) use lower ratios (~2.5-2.8) because their tokenizers are optimized for Chinese. GPT/Claude use higher ratios (~3.5-4.0).

---

## 3. Agent Pipeline

```
[User Input]
    ↓
[Repo Scanner] ──→ Knowledge Graph + Fingerprints + Import Map
    ↓
[Fault Detector] ──→ Findings (type, confidence, location)
    ↓
[Context Builder] ──→ Recalled nodes (entry points + propagation results)
    ↓
[Web Searcher] (Phase 3) ──→ External solutions (conditional)
    ↓
[Root Cause Analyzer] ──→ Root cause + severity
    ↓
[Solution Planner] ──→ Structured plan (changes per file)
    ↓
[Patch Generator] ──→ File patches (add/modify/delete)
    ↓
[Review Interface] ──→ Diff preview + user decision
    ↓
[Git Executor] (Phase 4) ──→ Branch / commit / push
```

Each agent extends `BaseAgent` with standardized input/output via Zod schemas.

---

## 4. Memory Layers

### L1: Repo Memory (Static)
- Knowledge graph
- Fingerprints
- Import map
- Persisted to `.repair-agent/memory.json`

### L2: Task Memory (Dynamic)
- Task ID
- Analyzed files set
- Recalled nodes
- Search cache
- Findings
- Token budget status
- Cleared after task completion

### L3: Learned Memory (Cross-Task)
- Task history
- Fault patterns
- Fix patterns
- Project conventions
- Structure ready, logic pending Phase 5

---

## 5. Token Optimization Strategies

| Strategy | Mechanism | Savings | Status |
|----------|-----------|---------|--------|
| Fingerprint skip | Skip unchanged files | 80-95% | ✅ |
| Fault propagation | Analyze only affected paths | 70-90% | ✅ |
| Incremental graph | Update only changed nodes | 90%+ | ✅ |
| Semantic cache | Reuse similar analysis results | 60-80% | Phase 3 |
| Search degradation | Skip web search when local sufficient | 100% search | Phase 3 |
| Context compression | Graph instead of full code | 50-70% | Phase 3 |
| Batch parallel | Parallel file analysis | Time | Phase 3 |
| Result cache | Cache search/analysis results | 80%+ | Phase 3 |

---

## 6. Security

### API Key Handling
1. **Environment variables** — `ANTHROPIC_API_KEY`, `MOONSHOT_API_KEY`, etc.
2. **User config** — `~/.code-agent/config.yaml` (permission 600)
3. **Project .env** — `.gitignore` protected
4. **Never**: hardcoded, logged in full, in error messages

### Log Masking
```
Initializing Anthropic client (model: claude-sonnet-4-6, key: sk-a****YhbK)
```

### Safety Nets
- All modifications require human review (`fix` command)
- `--auto-push` flag exists but defaults to false
- Patch conflicts detected before application
- Diff size and file count limits configurable
