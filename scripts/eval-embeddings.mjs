#!/usr/bin/env node
/**
 * C-layer Definition-of-Done eval (docs/GRAPH-ENRICHMENT-PLAN.md §7.8).
 *
 * The template stub makes the C-layer tests green, but its "similarity" is
 * char-trigram overlap — NOT meaning. A green stub therefore does not prove the
 * `similar_to`/`related` edges are semantically sensible. This script runs the
 * REAL ONNX model (LocalEmbeddingService's exact params: bge-small-en-v1.5,
 * mean-pool + L2-normalize) on curated code signatures and prints, side by side,
 * the cosine + threshold band each backend assigns — so a human can confirm the
 * real model bands semantically-related-but-lexically-different pairs that the
 * stub misses.
 *
 * Prereq: model downloaded under ./models (scripts/fetch-embedding-model.sh).
 * Run:    node scripts/eval-embeddings.mjs
 */
import { existsSync } from 'fs';
import { join } from 'path';

const MODEL_DIR = 'models/Xenova/bge-small-en-v1.5';
if (!existsSync(join(MODEL_DIR, 'onnx', 'model_quantized.onnx'))) {
  console.error(
    `Model not found under ${MODEL_DIR}.\n` +
      `Download it first:  scripts/fetch-embedding-model.sh`
  );
  process.exit(1);
}

// ---- Threshold bands (must mirror graph-enrich.ts / GRAPH-ENRICHMENT-PLAN §7.1) ----
const SIMILAR_TO = 0.85; // cos >= 0.85
const RELATED = 0.7; // 0.70 <= cos < 0.85
function band(cos) {
  if (cos >= SIMILAR_TO) return 'similar_to';
  if (cos >= RELATED) return 'related';
  return '—';
}
const cosine = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0); // inputs are L2-normalized

// ---- Template stub, replicated to match TemplateEmbeddingService exactly ----
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function stubEmbed(text, dim = 256) {
  const vec = new Array(dim).fill(0);
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!norm) return vec;
  const padded = `  ${norm}  `;
  for (let i = 0; i + 3 <= padded.length; i++) vec[fnv1a(padded.slice(i, i + 3)) % dim] += 1;
  let mag = 0;
  for (const v of vec) mag += v * v;
  if (mag === 0) return vec;
  const inv = 1 / Math.sqrt(mag);
  return vec.map((v) => v * inv);
}

// ---- Curated pairs. `expect` is the human-judged ground truth. ----
const PAIRS = [
  // Semantically related, lexically DIFFERENT — the case the stub cannot see.
  { a: 'getUserById(id: string) -> User', b: 'fetchUser(userId: string) -> User', expect: 'related/similar' },
  { a: 'function authenticate(user, password) -> Session', b: 'function login(credentials) -> Session', expect: 'related/similar' },
  { a: 'class HttpClient { get post put delete }', b: 'class ApiRequester { send fetch request }', expect: 'related/similar' },
  { a: 'function deleteFile(path) -> void', b: 'function removeDocument(uri) -> void', expect: 'related/similar' },
  // Unrelated — both backends should say "—".
  { a: 'getUserById(id: string) -> User', b: 'renderTriangle(vertices) -> void', expect: '—' },
  { a: 'function authenticate(user, password) -> Session', b: 'function computeFactorial(n) -> number', expect: '—' },
];

const { pipeline, env } = await import('@huggingface/transformers');
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = 'models';

console.log('Loading bge-small-en-v1.5 (dtype=q8) from ./models ...');
const t0 = Date.now();
const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', { dtype: 'q8' });
console.log(`Loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const texts = [...new Set(PAIRS.flatMap((p) => [p.a, p.b]))];
const out = (await extractor(texts, { pooling: 'mean', normalize: true })).tolist();
const realVec = new Map(texts.map((t, i) => [t, out[i]]));

console.log('pair                                        | real cos  band       | stub cos  band       | expect');
console.log('-'.repeat(108));
let stubMisses = 0;
let realCorrect = 0;
for (const { a, b, expect } of PAIRS) {
  const real = cosine(realVec.get(a), realVec.get(b));
  const stub = cosine(stubEmbed(a), stubEmbed(b));
  const label = `${a.slice(0, 20)} ~ ${b.slice(0, 18)}`.padEnd(43);
  console.log(
    `${label} | ${real.toFixed(3)}     ${band(real).padEnd(10)} | ${stub.toFixed(3)}     ${band(stub).padEnd(10)} | ${expect}`
  );
  const shouldBand = expect !== '—';
  if (shouldBand) {
    if (band(real) !== '—') realCorrect++;
    if (band(stub) === '—') stubMisses++; // stub failed to surface a real relation
  }
}

console.log('-'.repeat(108));
const semanticPairs = PAIRS.filter((p) => p.expect !== '—').length;
console.log(
  `\nReal model banded ${realCorrect}/${semanticPairs} semantically-related pairs.`
);
console.log(
  `Template stub MISSED ${stubMisses}/${semanticPairs} of them (scored "—" despite a real relation).`
);
console.log(
  stubMisses > 0 && realCorrect >= semanticPairs - 1
    ? '\n✅ DoD: the real model captures semantics the lexical stub cannot. C-layer edges are meaningful.'
    : '\n⚠️  Review the numbers above by hand before declaring the C layer done.'
);
