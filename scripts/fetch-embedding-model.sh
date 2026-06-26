#!/usr/bin/env bash
# ============================================================================
# One-command setup for the C-layer ONNX embedding model.
#
#   npm run setup:embeddings          # from a fresh clone, after `npm install`
#
# Downloads bge-small-en-v1.5 (q8, ~34MB) into ./models so transformers.js loads
# it LOCALLY — no runtime download. LocalEmbeddingService auto-detects ./models,
# so afterwards `code-agent init <repo> --embeddings local` just works (no env var).
#
# ----------------------------------------------------------------------------
# WHY THIS SCRIPT EXISTS (pitfalls learned the hard way — see also
# docs/EMBEDDING-SETUP.md and memory: embedding-model-offline-setup):
#
#  1. transformers.js downloads from HuggingFace Hub on first embed(). On
#     restricted networks (e.g. behind the GFW) huggingface.co is unreachable
#     (ECONNRESET; the CDN host won't even resolve) — first embed() just fails.
#
#  2. The mirror hf-mirror.com IS reachable, but transformers.js uses undici with
#     a hard-coded 10s connect timeout, and the mirror's TLS handshake can take
#     ~20s — so pointing the library at the mirror STILL times out.
#
#  => The robust fix is to prefetch with curl (long timeout, here) into ./models
#     and load locally. That sidesteps both the blocked host and the short timeout.
#
# Override the source if needed:
#   HF_HOST=https://huggingface.co npm run setup:embeddings   # if you have hub access
#   REPO=Xenova/all-MiniLM-L6-v2 npm run setup:embeddings     # a different model
# ============================================================================
set -euo pipefail

REPO="${REPO:-Xenova/bge-small-en-v1.5}"
HF_HOST="${HF_HOST:-https://hf-mirror.com}"
DEST="models/${REPO}"
BASE="${HF_HOST}/${REPO}/resolve/main"
WEIGHTS="${DEST}/onnx/model_quantized.onnx"

# Idempotent: skip if already present (weights are the expensive part).
if [ -f "${DEST}/config.json" ] && [ -s "${WEIGHTS}" ]; then
  echo "Model already present at ${DEST} — nothing to do."
  echo "(Delete ${DEST} to re-download.)"
  exit 0
fi

# The model files are fetched with curl, but RUNNING the model needs the optional
# dep. Warn early if a fresh clone skipped `npm install`.
if [ ! -d "node_modules/@huggingface/transformers" ]; then
  echo "WARNING: @huggingface/transformers is not installed."
  echo "         Run 'npm install' first, then re-run this script." >&2
fi

mkdir -p "${DEST}/onnx"
echo "Fetching ${REPO} from ${HF_HOST} -> ${DEST}"

for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json; do
  curl -fsSL -m 120 -o "${DEST}/${f}" "${BASE}/${f}"
  echo "  ${f} ($(wc -c <"${DEST}/${f}" | tr -d ' ') bytes)"
done

# Quantized weights (~34MB) — the dtype=q8 default used by LocalEmbeddingService.
echo "  downloading onnx/model_quantized.onnx (~34MB, may take a minute over the mirror) ..."
curl -fsSL -m 600 -o "${WEIGHTS}" "${BASE}/onnx/model_quantized.onnx"

# Sanity-check the weights are a real download, not an HTML error page.
SIZE=$(wc -c <"${WEIGHTS}" | tr -d ' ')
if [ "${SIZE}" -lt 1000000 ]; then
  echo "ERROR: weights file is only ${SIZE} bytes — download likely failed." >&2
  echo "       Try a different HF_HOST, or check your network." >&2
  rm -f "${WEIGHTS}"
  exit 1
fi
echo "  onnx/model_quantized.onnx (${SIZE} bytes)"

echo ""
echo "Done. Verify with:  npm run eval:embeddings"
echo "Use with:           code-agent init <repo> --embeddings local"
