#!/usr/bin/env npx tsx
/**
 * 一次性数据迁移：人物 id `p<n>` → `persona/<n>`
 *
 * 背景：id 原先是裸 `p1`，光看一个引用（`persona: p1`）不知道它属于哪类实体。
 * 现在统一成 **`实体/序号`** 的路径式标识（与任务 URI `projects/4/tasks/182` 同一读法），
 * 一眼能对上"这是 persona 的第 1 号"。名字仍是纯标签（可改），引用一律用 id。
 *
 * 迁移内容（确定性、可重跑）：
 *   ① personas.yaml：每个 key `p<n>` → `persona/<n>`，`default` 同步改写
 *   ② 任务 AGENTS.md：`persona: p<n>` → `persona: persona/<n>`（文本级只换那一行的值）
 *   ③ 已是新格式的（`persona/<n>`）原样不动（可重跑）
 *   ④ 不写 `persona:` 键的任务原样不动 —— 那是**跟随缺省**（新默认），不是待迁移数据
 *
 * 不做的事：
 *   · 不给任务**补** persona 键（新建任务默认跟随缺省，缺键是常态）
 *   · 不动任务里的其它 frontmatter 字段
 *
 * 用法：
 *   npx tsx scripts/migrate-persona-id-prefix.mts                 # dry-run（默认 ~/.diy）
 *   npx tsx scripts/migrate-persona-id-prefix.mts --home <dir>    # 指定数据根预演
 *   npx tsx scripts/migrate-persona-id-prefix.mts --apply         # 写盘（先备份）
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
/**
 * 存量任务的 person 键怎么处理：
 *   `rename`（默认，保守）= 只改 id 写法（`p1` → `persona/1`），绑定语义不变（仍是固定绑定）
 *   `follow`             = 把「值等于当前缺省人物」的任务改成**跟随缺省**（删键）
 *
 * 为什么默认保守：`follow` 会改变这些任务**将来的行为**（今后改缺省它们会跟着变），
 * 这是一次语义变更，不该混在"改 id 写法"这种纯机械迁移里一起做掉 —— 要分开、可分辨、可回退。
 */
const TASKS_MODE: "rename" | "follow" = args.includes("--tasks-follow") ? "follow" : "rename";
const homeIdx = args.indexOf("--home");
const HOME = (homeIdx >= 0 ? args[homeIdx + 1] : join(homedir(), ".diy"))!;

/** `p3` → `persona/3`；已是 `persona/3` 则原样返回；其余（含手写的怪 id）原样不动 */
function toNewId(id: string): string {
    const m = /^p(\d+)$/.exec(id);
    return m ? `persona/${m[1]}` : id;
}

/** 收集 projects 下的 AGENTS.md（跳过点目录） */
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

let changedFiles = 0;

// ── ① personas.yaml ──
const pf = join(HOME, "personas.yaml");
if (existsSync(pf)) {
    const raw = yaml.load(readFileSync(pf, "utf-8")) as
        | { default?: string; personas?: Record<string, unknown> }
        | null;
    if (raw?.personas) {
        const nextPersonas: Record<string, unknown> = {};
        let renamed = 0;
        for (const [id, def] of Object.entries(raw.personas)) {
            const nid = toNewId(id);
            if (nid !== id && Object.hasOwn(raw.personas, nid)) {
                throw new Error(`人物 id 冲突：${id} 迁移到 ${nid}，但目标 id 已存在；未写入任何文件`);
            }
            if (Object.hasOwn(nextPersonas, nid)) {
                throw new Error(`人物 id 冲突：多个 id 映射到 ${nid}；未写入任何文件`);
            }
            if (nid !== id) renamed++;
            nextPersonas[nid] = def;
        }
        const nextDefault = toNewId(String(raw.default ?? ""));
        const needs = renamed > 0 || nextDefault !== String(raw.default ?? "");
        console.log(`personas.yaml：${renamed} 个 id 需改写，default ${raw.default} → ${nextDefault}`);
        if (needs) {
            changedFiles++;
            if (APPLY) {
                copyFileSync(pf, `${pf}.pre-id-prefix.bak`);
                writeFileSync(
                    pf,
                    yaml.dump({ ...raw, default: nextDefault, personas: nextPersonas }, { indent: 2, noRefs: true }),
                    "utf-8",
                );
                console.log(`  已写盘（备份 ${pf}.pre-id-prefix.bak）`);
            }
        }
    }
} else {
    console.log(`personas.yaml：不存在，跳过`);
}

// ── ② 任务 frontmatter ──
// 当前缺省人物（新 id 写法）；`--tasks-follow` 时"值等于它"的任务改成跟随
const curDefault = (() => {
    if (!existsSync(pf)) return "";
    const raw = yaml.load(readFileSync(pf, "utf-8")) as { default?: string } | null;
    return toNewId(String(raw?.default ?? ""));
})();

const files = walk(join(HOME, "projects"));
let taskHits = 0;
let followHits = 0;
for (const fp of files) {
    const text = readFileSync(fp, "utf-8");
    let next = text;
    if (TASKS_MODE === "follow") {
        // 删掉整行 `persona: <当前缺省 id>` → 该任务改为跟随缺省
        next = next.replace(/^persona:[ \t]*(\S+)[ \t]*(\r?\n)/m, (line, id: string, eol: string) => {
            if (toNewId(id) !== curDefault) return line;
            followHits++;
            return eol;
        });
    }
    // 剩下的（固定绑定）只改 id 写法；其余行逐字节不变
    next = next.replace(/^persona:[ \t]*(\S+)[ \t]*(\r?)$/gm, (line, id: string, cr: string) => {
        const nid = toNewId(id);
        if (nid === id) return line;
        taskHits++;
        return `persona: ${nid}${cr}`;
    });
    if (next !== text) {
        changedFiles++;
        if (APPLY) {
            copyFileSync(fp, `${fp}.pre-id-prefix.bak`);
            writeFileSync(fp, next, "utf-8");
        }
    }
}
console.log(
    `任务 AGENTS.md：扫描 ${files.length} 个，改写 id 写法 ${taskHits} 处` +
        (TASKS_MODE === "follow" ? `，改为跟随缺省 ${followHits} 处（当前缺省 ${curDefault}）` : ""),
);
if (TASKS_MODE === "rename") {
    console.log("  （默认只改 id 写法；加 --tasks-follow 可把「绑定当前缺省」的任务改成跟随缺省）");
}

console.log(`\n合计需改动 ${changedFiles} 个文件。`);
if (!APPLY) {
    console.log("（dry-run，未写盘。确认无误后加 --apply）");
} else {
    console.log("已写盘。");
}
