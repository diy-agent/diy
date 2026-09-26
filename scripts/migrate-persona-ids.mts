#!/usr/bin/env npx tsx
/**
 * 一次性数据迁移：人物引用从**名字**改为 **id**
 *
 * 背景：人物最初以名字（"大副"）既当 key 又当引用键。名字是给人看的标签、随时会改，
 * 一旦拿它当引用，改名就等于把所有引用打断 —— 引用者静默回落缺省人物（换模型不打招呼）。
 * 现在 personas.yaml 的结构是 `{default: <id>, personas: {<id>: {name, model, …}}}`，
 * 任务 frontmatter 的 `persona` 也存 id。本脚本把存量数据搬过去。
 *
 * 迁移内容（确定性、可重跑）：
 *   ① personas.yaml：名字键 → 自动 id（p1 起，按原书写顺序）；
 *      `desc` 字段删除（名字本身就是说明，模型/档位在界面始终可见）；`default` 改为 id
 *   ② 任务 AGENTS.md：`persona: 大副` → `persona: p1`（按名字映射；文本级只换那一行的值）
 *   ③ 已经是 id 的任务 / 已是新结构的人物表：原样不动（可重跑）
 *
 * 用法：
 *   npx tsx scripts/migrate-persona-ids.mts                 # dry-run（默认 ~/.diy）
 *   npx tsx scripts/migrate-persona-ids.mts --home <dir>    # 指定数据根预演
 *   npx tsx scripts/migrate-persona-ids.mts --apply         # 写盘（先备份 .pre-persona-ids.bak）
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const homeIdx = args.indexOf("--home");
const HOME = (homeIdx >= 0 ? args[homeIdx + 1] : join(homedir(), ".diy"))!;
const FM = "---";

interface OldDef {
    name?: string;
    model?: string;
    reasoningEffort?: string;
    style?: string;
    desc?: string;
}

/** 读旧结构人物表（宽容：键可能是名字（旧）也可能是 id（已是新结构）） */
function readOldPersonas(): { default: string; entries: Array<{ key: string; def: OldDef }> } | null {
    const p = join(HOME, "personas.yaml");
    if (!existsSync(p)) return null;
    const raw = yaml.load(readFileSync(p, "utf-8")) as { default?: string; personas?: Record<string, OldDef> } | null;
    if (!raw?.personas) return null;
    return {
        default: String(raw.default ?? ""),
        entries: Object.entries(raw.personas).map(([key, def]) => ({ key, def: def ?? {} })),
    };
}

/** 收集 projects 下的 AGENTS.md（跳过 .diy 等点目录） */
function walk(dir: string, acc: string[] = []): string[] {
    if (!existsSync(dir)) return acc;
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (e === "AGENTS.md") acc.push(p);
        else if (e.startsWith(".")) continue;
        else if (statSync(p).isDirectory()) walk(p, acc);
    }
    return acc;
}

const old = readOldPersonas();
if (!old) {
    console.log(`没有 personas.yaml（${HOME}）—— 无需迁移（系统会用内置人物）。`);
    process.exit(0);
}

// ── ① 人物表：名字键 → id ──
// 已是新结构（键是 p<数字> 且 def.name 存在）时保持原 id；否则按顺序生成 p1, p2, …
let next = 1;
const usedIds = new Set(old.entries.filter((e) => /^p\d+$/.test(e.key)).map((e) => e.key));
const keyToId = new Map<string, string>();
const personas: Record<string, { name: string; model: string; reasoningEffort: string; style: string }> = {};

for (const { key, def } of old.entries) {
    let id: string;
    if (/^p\d+$/.test(key) && def.name) {
        id = key; // 已是新结构
    } else {
        while (usedIds.has(`p${next}`)) next++;
        id = `p${next}`;
        usedIds.add(id);
    }
    keyToId.set(key, id);
    personas[id] = {
        // 旧结构没有 name 字段 → 用 key（那就是名字）
        name: def.name ?? key,
        model: String(def.model ?? ""),
        reasoningEffort: String(def.reasoningEffort ?? "medium"),
        style: String(def.style ?? ""),
    };
}
// 名字 → id 的映射（含**已迁移**人物的 name）：用于"人物表已是新结构、任务还存名字"的半迁移状态。
// 只看 key 会漏掉这种状态（key 已是 p1，任务里的"大副"就找不到对应）—— 实测踩到过。
const nameToId = new Map<string, string>();
for (const [id, def] of Object.entries(personas)) nameToId.set(def.name, id);
/** 任务里的引用值 → id：先按 key（旧结构），再按名字（半迁移/手写名字） */
const resolveRef = (value: string): string | undefined => keyToId.get(value) ?? nameToId.get(value);

const defaultId = keyToId.get(old.default) ?? nameToId.get(old.default) ?? Object.keys(personas)[0]!;
const newFile = yaml.dump(
    { default: defaultId, personas },
    { indent: 2, noRefs: true, lineWidth: -1 },
);

// ── ② 任务：persona 由名字换成 id ──
const files = walk(join(HOME, "projects"));
const changedTasks: Array<{ uri: string; from: string; to: string }> = [];
const skipped: string[] = [];

for (const file of files) {
    const raw = readFileSync(file, "utf-8");
    if (!raw.startsWith(FM)) {
        skipped.push(`${file}（无 frontmatter）`);
        continue;
    }
    const endIdx = raw.indexOf(FM, 3);
    const fmText = raw.slice(3, endIdx);
    const m = /^persona:\s*(.+)$/m.exec(fmText);
    if (!m) continue; // 无该字段：由读侧回落（不在这里补，那是另一个迁移的事）
    const value = m[1]!.trim().replace(/^['"]|['"]$/g, "");
    if (/^p\d+$/.test(value)) continue; // 已是 id
    const id = resolveRef(value);
    if (!id) {
        skipped.push(`${file}：persona=${value} 不在人物表里（保持原样，读侧会回落并出声）`);
        continue;
    }
    const uri = file.replace(join(HOME, "projects") + "/", "").replace("/AGENTS.md", "");
    changedTasks.push({ uri, from: value, to: id });
    if (APPLY) {
        copyFileSync(file, `${file}.pre-persona-ids.bak`);
        // 文本级只替换该行的值（不动其余字节）
        const nextFm = fmText.replace(/^persona:\s*.+$/m, `persona: ${id}`);
        writeFileSync(file, `${FM}${nextFm}${raw.slice(endIdx)}`, "utf-8");
    }
}

console.log(`${APPLY ? "【APPLY】" : "【DRY-RUN】"} HOME=${HOME}`);
console.log(`\n人物表：${old.entries.length} 个人物，default ${old.default} → ${defaultId}`);
for (const { key } of old.entries) console.log(`  ${key} → ${keyToId.get(key)}（${personas[keyToId.get(key)!]!.name}）`);
console.log(`\n任务：扫描 ${files.length} 个 AGENTS.md，需换 id ${changedTasks.length} 个、跳过 ${skipped.length} 个`);
for (const t of changedTasks.slice(0, 5)) console.log(`  ${t.uri}: ${t.from} → ${t.to}`);
if (changedTasks.length > 5) console.log(`  …（其余 ${changedTasks.length - 5} 个同理）`);
if (skipped.length) {
    console.log("\n跳过：");
    for (const s of skipped.slice(0, 10)) console.log("  ! " + s);
}
if (APPLY) {
    copyFileSync(join(HOME, "personas.yaml"), join(HOME, "personas.yaml.pre-persona-ids.bak"));
    writeFileSync(join(HOME, "personas.yaml"), newFile, "utf-8");
    console.log(`\n已写盘（备份：personas.yaml.pre-persona-ids.bak、各任务 *.pre-persona-ids.bak）`);
} else {
    console.log(`\n未写盘。确认无误后加 --apply（会先备份 *.pre-persona-ids.bak）`);
}
