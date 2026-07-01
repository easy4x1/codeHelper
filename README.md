# Code Repair Agent

**English** · [简体中文](./README.zh-CN.md)

> AI-powered code repair agent with fingerprint-based incremental analysis and multi-provider LLM support.

[![Tests](https://img.shields.io/badge/tests-354%2F354%20passing-brightgreen)](#development)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24.0-green)](https://nodejs.org/)

Code Repair Agent is a structured, multi-agent pipeline for automated code repair. It pairs deterministic static analysis (Tree-sitter parsing, structural fingerprinting) with LLM-based semantic reasoning to minimize token consumption without sacrificing accuracy. Every proposed change passes through a human review gate before it reaches the repository.

## Features

- **Hybrid Code Analysis** — Repository scanning, knowledge-graph construction, and fault detection through a Tree-sitter + LLM architecture across six languages.
- **Three-Layer Memory** — Repository-static (L1), task-dynamic (L2), and cross-task learned (L3) memory, all persisted automatically.
- **Incremental Analysis** — Structural fingerprinting skips unchanged files, cutting token usage by 80–95% on incremental tasks.
- **Fault Propagation** — Probability-weighted BFS traversal traces impact along call chains to scope the analysis set.
- **Token Budget Control** — A four-tier degradation ladder (reduce depth → disable search → core-only → prompt user) enforces a configurable budget.
- **Multi-Provider LLM** — Anthropic, OpenAI, Moonshot (Kimi), DeepSeek, and Zhipu (GLM), with model-aware token estimation and automatic fallback.
- **Web Search** — Tavily as the primary provider (keyless or API-key), with DuckDuckGo and simulation fallbacks plus result caching.
- **Knowledge-Graph Enrichment** — Layered semantic enrichment beyond the deterministic core graph (A: static, B: framework-aware, C: embeddings, D: LLM).
- **Git Automation** — Automated branch creation, commit, and push, guarded by protected-branch and pre-commit safety checks.
- **Observability** — Built-in metrics for agent latency, token usage, cache hit rates, and parser coverage.
- **Continuous Learning** — Fault/fix pattern extraction, project-convention learning, and recommendation of prior solutions.
- **Secure Review Flow** — Layered API-key resolution with log masking, and a human-in-the-loop diff review before any change is applied.

## Quick Start

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd code-repair-agent

# Install dependencies
npm install

# Build
npm run build

# Link for global CLI usage
npm link
```

### Configuration

#### LLM API Keys

Set via environment variable (recommended):

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

Or create a `.env` file (already in `.gitignore`):

```bash
cp .env.example .env
# Edit .env with your keys
```

#### Web Search (Tavily)

Tavily is the primary search provider. It works in **keyless mode** by default (no setup needed), or you can provide an API key for higher rate limits:

```bash
# Via environment variable
export TAVILY_API_KEY=tvly-xxxxxxxxxxxxxxxx

# Or user config file (~/.code-agent/config.yaml)
tavily:
  apiKey: tvly-xxxxxxxxxxxxxxxx
```

Get a free API key at [tavily.com](https://tavily.com). When rate limits are hit, it automatically falls back to DuckDuckGo → simulation.

#### Embeddings (C-layer graph enrichment)

The optional C-layer adds `similar_to`/`related` edges and `concept` clusters using a local ONNX model (zero token). One command downloads it (~34MB, into `./models`, git-ignored):

```bash
npm run setup:embeddings    # fetch the model once per machine
code-agent init <repo> --embeddings local   # auto-detects ./models, no env var needed
```

On restricted networks the script uses a mirror; see [docs/EMBEDDING-SETUP.md](docs/EMBEDDING-SETUP.md) for pitfalls, config, and CI/Docker notes.

### Initialize a Repository

```bash
code-agent init ./my-project
```

This scans the repository, builds a knowledge graph, and persists fingerprints to `.repair-agent/memory.json`.

### Analyze and Fix

```bash
# Interactive fix (plan → patch → review → apply)
code-agent fix "Fix memory leak in user service" --provider anthropic --model claude-sonnet-4-6

# Generate plan only
code-agent plan "Refactor auth module" --provider moonshot --model kimi-k2.5

# Apply an already-reviewed plan
code-agent apply plan-123

# Disable web search for local-only analysis
code-agent plan "Fix null pointer" --no-web-search

# View project metrics
code-agent metrics

# View task history
code-agent history

# Learn project conventions
code-agent learn
```

### Incremental Sync

After code changes, update the knowledge graph incrementally:

```bash
code-agent sync ./my-project
```

## CLI Commands

| Command | Description | Options |
|---------|-------------|---------|
| `init [repo-path]` | Scan repo and build knowledge graph | — |
| `plan <description>` | Generate repair plan only | `--provider`, `--model`, `--budget`, `--file`, `--web-search` |
| `fix <description>` | Full interactive repair flow | `--provider`, `--model`, `--budget`, `--auto-push`, `--file`, `--web-search` |
| `apply <plan-id>` | Apply approved plan non-interactively | `--dry-run` |
| `sync [repo-path]` | Incremental sync after code changes | `--force-full` |
| `status [repo-path]` | Show knowledge graph statistics | — |
| `batch <tasks.json>` | Batch process multiple repair tasks | `--parallel`, `--auto-push` |
| `history` | View task history, patterns, conventions | — |
| `learn` | Learn project conventions from codebase | — |
| `metrics` | Show performance metrics and statistics | `--json`, `--reset` |

## Supported LLM Providers

| Provider | Model Examples | Environment Variable |
|----------|---------------|---------------------|
| **Anthropic** | `claude-sonnet-4-6`, `claude-opus-4-8` | `ANTHROPIC_API_KEY` |
| **OpenAI** | `gpt-5.4`, `gpt-5.5`, `gpt-4o` | `OPENAI_API_KEY` |
| **Moonshot (Kimi)** | `kimi-k2.5`, `kimi-k2.6` | `MOONSHOT_API_KEY` |
| **DeepSeek** | `deepseek-chat`, `deepseek-coder` | `DEEPSEEK_API_KEY` |
| **Zhipu (GLM)** | `glm-5.1` | `ZHIPU_API_KEY` |
| **Template** (mock) | — | None |

## Architecture

```
User Input → Task Planner → Repo Scanner → Knowledge Graph
                                    ↓
                         Memory Middleware (L1/L2/L3)
                                    ↓
              Fault Detector → Context Builder → Web Searcher
                                    ↓
              Root Cause Analyzer → Solution Planner → Patch Generator
                                    ↓
                           Review Interface → Git Executor
                                    ↓
                         Learning Agent (patterns + conventions)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed architecture documentation.

## Development

```bash
# Run tests
npm test

# Run tests once (CI)
npm run test:run

# Watch mode
npm run dev
```

## Documentation

- [DESIGN.md](DESIGN.md) — System design (v1.0.0)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Architecture details
- [docs/API.md](docs/API.md) — CLI and programmatic API reference
- [docs/EMBEDDING-SETUP.md](docs/EMBEDDING-SETUP.md) — C-layer embedding model setup + offline pitfalls
- [PROGRESS.md](PROGRESS.md) — Implementation progress
- [CONTEXT.md](CONTEXT.md) — Project background and decisions
- [KEY-FINDINGS.md](KEY-FINDINGS.md) — Understand-Anything analysis

## License

MIT
