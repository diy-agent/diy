#!/usr/bin/env node
// 从 models.dev api.json 生成 **npm 白名单快照**（产物 src/main/data/models.dev.json）。
//
// 白名单 = 当前 diy 支持的 ai-sdk 包面（其余 npm 包接入是后续任务，见 ##184）：
//   @ai-sdk/openai-compatible（chat 面）· @ai-sdk/openai（responses 面）
// 产物结构与 models.dev api.json **完全同构**（顶层 provider map，原字段原样），
// 运行时 registry 只读它 —— 即讨论定下的「models.dev 为唯一真源」。
//
// 这是**上游产物**：整份覆盖（无手写内容）—— diy 自己的补充一律进 models.dev.diy.json。
//
// 用法：
//   npx tsx scripts/gen-models-dev.mts [源]      # 源 = 本地文件路径 或 URL
//   缺省源 = https://models.dev/api.json
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NPM_ALLOW = ["@ai-sdk/openai-compatible", "@ai-sdk/openai"];
const src = process.argv[2] ?? "https://models.dev/api.json";
const raw = src.startsWith("http")
  ? await (await fetch(src)).text()
  : readFileSync(src, "utf-8");
const all = JSON.parse(raw);
const out = Object.fromEntries(
  Object.entries(all as Record<string, { npm?: string }>).filter(([, p]) => NPM_ALLOW.includes(p.npm ?? "")),
);
const models = Object.values(out as Record<string, { models: Record<string, unknown> }>).reduce(
  (n, p) => n + Object.keys(p.models).length,
  0,
);
const dest = join(dirname(fileURLToPath(import.meta.url)), "../src/main/data/models.dev.json");
writeFileSync(dest, JSON.stringify(out), "utf-8");
console.log(`models.dev: ${Object.keys(out).length} providers / ${models} models → ${dest}`);
