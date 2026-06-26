# C 层 Embedding 模型设置

> C 层知识图谱增强（`similar_to`/`related` 边 + `concept` 聚类）由 `LocalEmbeddingService`
> 提供，经本地 ONNX 模型（默认 `bge-small-en-v1.5`，零 token）计算节点向量。
> 本文档说明换设备 / 全新 clone 后如何一条命令装好模型，以及踩过的坑。

---

## 快速开始（换台机器也照此）

```bash
npm install                 # 装依赖（含 optional dep @huggingface/transformers）
npm run setup:embeddings    # 一条命令：下载模型到 ./models（约 34MB，幂等）
npm run eval:embeddings     # 可选：验证模型语义可用（真实 vs 桩对比）

# 之后直接用，无需任何环境变量：
code-agent init <repo> --embeddings local
code-agent sync <repo> --embeddings local
```

`LocalEmbeddingService` 会**自动探测** `./models` 目录，所以 `setup:embeddings` 跑过一次后
`--embeddings local` 即开即用，不需要再设 `EMBEDDING_MODEL_PATH`。

> 模型不进 git（`.gitignore: models/`）。每台新机器跑一次 `npm run setup:embeddings` 即可。
> 这是业界标准做法——大二进制按需获取，不塞进版本库（详见根目录讨论 / README）。

---

## 踩坑经验（为什么不是"配好就能远程下载"）

`@huggingface/transformers`（transformers.js）默认在首次 `embed()` 时从 HuggingFace Hub
下载模型。在受限网络下这条路走不通，具体踩到两个坑：

1. **HF Hub 直连不可达**：`huggingface.co` 直接 `ECONNRESET`，CDN 域名（`cdn-lfs.huggingface.co`）
   连 DNS 都解析不了 → 首次 `embed()` 直接抛 `fetch failed`。

2. **镜像可达但库内超时写死**：国内镜像 `hf-mirror.com` 可达，但 transformers.js 内部用
   undici，**连接超时硬编码 10 秒**，而镜像 TLS 握手要 ~20 秒 → 即便把库指向镜像
   （`env.remoteHost`）仍然 `UND_ERR_CONNECT_TIMEOUT`。

**结论 / 绕过方式**：用 `curl`（可设长超时）走镜像把模型**预下载**到 `./models`，再让服务
从本地加载（`env.allowLocalModels=true` + `allowRemoteModels=false`）。这同时绕开"被墙的主机"
和"库内 10s 超时"两个问题。`scripts/fetch-embedding-model.sh` 就是干这个的。

---

## 配置项（按优先级）

`LocalEmbeddingService` 解析模型来源的顺序：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | 显式 `modelPath` / `EMBEDDING_MODEL_PATH` | 指定本地模型目录，强制本地、不下载 |
| 2 | **自动探测 `./models/<repo>`** | 存在即用（`setup:embeddings` 的产物），无需 env |
| 3 | 远程 Hub（可选经 `HF_ENDPOINT` 镜像） | 有 Hub 访问的机器走这条；受限网络会失败 |

其他可调环境变量：

| 变量 | 默认 | 作用 |
|------|------|------|
| `HF_ENDPOINT` | （空，用官方 Hub） | 远程下载时的镜像主机 |
| `EMBEDDING_DTYPE` | `q8` | ONNX 量化精度（`q8` ≈ 34MB；`fp32` 更大更准） |
| `EMBEDDING_MODEL_PATH` | （空，自动探测 `./models`） | 强制指定本地模型目录 |

脚本侧覆盖：

```bash
HF_HOST=https://huggingface.co npm run setup:embeddings   # 有 Hub 访问时直连官方
REPO=Xenova/all-MiniLM-L6-v2 npm run setup:embeddings     # 换个模型（384 维，更小）
```

---

## CI / 部署

- **CI**：在测试前跑 `npm run setup:embeddings` 并缓存 `./models` 目录（只下一次）。
  真实模型的 DoD 测试用例（`tests/embedding-service.test.ts`）在模型存在时自动启用，
  缺失则 `describe.skipIf` 跳过——不会静默假装通过。
- **Docker**：在镜像构建阶段 `RUN npm run setup:embeddings`，模型固化进镜像层，运行时零网络。

---

## 验证

```bash
npm run eval:embeddings
```

输出真实模型 vs 模板桩的 side-by-side 余弦相似度对比。真实模型应把**语义相关但词法不同**的
签名对（如 `authenticate(...)` ~ `login(...)`）正确分带为 `similar_to`/`related`，而桩会漏判。
设计与 DoD 判据见 `docs/GRAPH-ENRICHMENT-PLAN.md` §7.8。
