#!/usr/bin/env npx tsx
/**
 * 一次性数据迁移：人物字段 `style` → `instructions`
 *
 * 背景：这个字段原本叫 `style`、界面叫「口气」，但它能装的不只是措辞语气 ——
 * "先给结论再给依据""审查时优先指出风险"这类**行为要求**同样写在这里，注入系统提示词的身份节。
 * `style`/`tone` 太窄（只像语气），`prompt` 太宽（像整个系统提示词），`context` 是另一回事。
 * 现在统一叫 `instructions`（业界对"给 agent 的固定指令"的通用叫法）+ 界面「行为指令」。
 *
 * 迁移内容（确定性、可重跑）：
 *   personas.yaml：每个 `personas.<id>.style` → `instructions`（值一字不改，只换键名）
 *
 * 不做的事：
 *   · 任务 frontmatter 不涉及（任务只存人物 **id** 引用，没有这个字段）
 *   · 模版文件（identity.md 等）不涉及（`{{persona.instructions}}` 由代码里的默认模版渲染）
 *
 * 用法：
 *   npx tsx scripts/migrate-persona-instructions.mts                 # dry-run（默认 ~/.diy）
 *   npx tsx scripts/migrate-persona-instructions.mts --home <dir>    # 指定数据根预演
 *   npx tsx scripts/migrate-persona-instructions.mts --apply         # 写盘（先备份 .pre-instructions.bak）
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const homeIdx = args.indexOf("--home");
const HOME = (homeIdx >= 0 ? args[homeIdx + 1] : join(homedir(), ".diy"))!;
const file = join(HOME, "personas.yaml");

if (!existsSync(file)) {
    console.log(`[skip] ${file} 不存在（没有人物配置，无需迁移）`);
    process.exit(0);
}

const raw = yaml.load(readFileSync(file, "utf-8")) as {
    default?: string;
    personas?: Record<string, Record<string, unknown>>;
} | null;

if (!raw?.personas) {
    console.log(`[skip] ${file} 里没有 personas 段，原样不动`);
    process.exit(0);
}

let changed = 0;
let already = 0;
const conflicts: string[] = [];
for (const [id, def] of Object.entries(raw.personas)) {
    if (!def || typeof def !== "object") continue;
    if (!Object.hasOwn(def, "style")) {
        if (Object.hasOwn(def, "instructions")) already++;
        continue;
    }
    if (Object.hasOwn(def, "instructions")) {
        // 两个键同时存在：拒绝猜（提醒人工处理），不静默丢弃任何一个值
        conflicts.push(id);
        console.error(`[error] 人物 ${id} 同时有 style 与 instructions，需人工确认`);
        continue;
    }
    // 键顺序：style 原本的位置换成 instructions（js-yaml 保序），值原样搬
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(def)) next[k === "style" ? "instructions" : k] = v;
    raw.personas[id] = next;
    changed++;
    console.log(`  ${id}: style→instructions（值 ${JSON.stringify(String(def["style"] ?? "")).slice(0, 60)}）`);
}

console.log(`\n人物表 ${file}：需迁移 ${changed} 个，已是新字段 ${already} 个`);
if (conflicts.length > 0) {
    console.error(`迁移中止：请先解决 ${conflicts.length} 个字段冲突，未写入任何文件。`);
    process.exit(1);
}
if (changed === 0) {
    console.log("无需迁移。");
    process.exit(0);
}
if (!APPLY) {
    console.log("\n（dry-run，未写盘。确认无误后加 --apply）");
    process.exit(0);
}

copyFileSync(file, `${file}.pre-instructions.bak`);
writeFileSync(file, yaml.dump(raw, { indent: 2, noRefs: true }), "utf-8");
console.log(`\n已写盘（备份 ${file}.pre-instructions.bak）`);
