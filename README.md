# Code Repair Agent

> AI-powered code repair agent with fingerprint-based incremental analysis and multi-provider LLM support.

[![Tests](https://img.shields.io/badge/tests-144%2F144%20passing-brightgreen)](#testing)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0-green)](https://nodejs.org/)

## Features

- **🔍 Intelligent Code Analysis** — Scan repositories, build knowledge graphs, and detect faults using Tree-sitter + LLM hybrid architecture
- **🧠 Three-Layer Memory** — L1 (repo static), L2 (task dynamic), L3 (learned cross-task) with automatic persistence
- **⚡ Fingerprint-Based Incremental Updates** — Skip unchanged files, achieving 80-95% token savings on daily tasks
- **🌊 Fault Propagation Engine** — Trace impact along call chains with probability-weighted BFS traversal
- **💰 Token Budget Control** — Four-level degradation strategy (reduce_depth → disable_search → core_only → prompt_user)
- **🌐 Multi-Provider LLM** — Support Anthropic, OpenAI, Moonshot (Kimi), DeepSeek, Zhipu (GLM), with automatic fallback
- **🔎 Web Search Integration** — Automatic external knowledge lookup when local confidence is low, with memory caching
- **🔒 API Key Security** — Environment variables → user config → .env, with automatic key masking in logs
- **📝 Interactive Review Flow** — Generate patches, preview diffs, approve/reject with human-in-the-loop

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

Set your LLM API key via environment variable (recommended):

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

## Supported LLM Providers

| Provider | Model Examples | Environment Variable |
|----------|---------------|---------------------|
| **Anthropic** | `claude-sonnet-4-6`, `claude-opus-4-8` | `ANTHROPIC_API_KEY` |
| **OpenAI** | `gpt-5.4`, `gpt-5.5`, `gpt-4o` | `OPENAI_API_KEY` |
| **Moonshot (Kimi)** | `kimi-k2.5`, `kimi-k2.6` | `MOONSHOT_API_KEY` |
| **DeepSeek** | `deepseek-chat`, `deepseek-coder` | `DEEPSEEK_API_KEY` |
| **Zhipu (GLM)** | `glm-5.1` | `ZHIPU_API_KEY` |
| **Template** (mock) | — | None |

### Token Estimation by Model

Different tokenizers produce different token counts for the same text. The agent automatically selects the correct estimation ratio:

| Model Family | chars/token | Chinese Adaptive |
|-------------|-------------|-----------------|
| GLM-5.1 | 2.5 | ✓ |
| Kimi K2 | 2.6 | ✓ |
| DeepSeek | 2.8 | ✓ |
| GPT-5.4/5.5 | 3.4-3.5 | ✓ |
| Claude | 3.8 | ✓ |

## Architecture

```
User Input → Task Planner → Repo Scanner → Knowledge Graph
                                    ↓
                         Memory Middleware (L1/L2/L3)
                                    ↓
              Fault Detector → Context Builder → Web Searcher (Phase 3)
                                    ↓
              Root Cause Analyzer → Solution Planner → Patch Generator
                                    ↓
                           Review Interface → Git Executor (Phase 4)
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

## Project Status

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 1: MVP | ✅ 100% | Core闭环: scan → detect → plan → patch → review |
| Phase 2: Memory Optimization | ✅ 100% | Fingerprint, propagation, token budget |
| Phase 3: Web Enhancement | ✅ 100% | Web search, result fusion, LLM patch generation |
| Phase 4: Automation | 🔴 0% | Git automation, CI/CD |
| Phase 5: Learning | 🔴 0% | Pattern extraction, project conventions |

See [PROGRESS.md](PROGRESS.md) for detailed progress.

## Documentation

- [DESIGN.md](DESIGN.md) — System design (v1.0.0)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Architecture details
- [docs/API.md](docs/API.md) — CLI and programmatic API reference
- [PROGRESS.md](PROGRESS.md) — Implementation progress
- [CONTEXT.md](CONTEXT.md) — Project background and decisions
- [KEY-FINDINGS.md](KEY-FINDINGS.md) — Understand-Anything analysis

## License

MIT
