#!/usr/bin/env npx tsx
/**
 * 一次性数据迁移：给存量任务补 `persona` 字段（agent 人物绑定）
 *
 * 背景：本层把"模型/参数属于谁"从会话的瞬时全局值改成了任务持有的**人物引用**
 * （`task frontmatter 的 persona` → `$DIY_HOME/personas.yaml` 的人物定义）。
 * 新建任务已由 createTask 物化该字段；改动之前建的任务没有它 —— 读侧虽然能回落缺省人物
 * （core/persona.ts 的 personaForTask），但那是为"用户手删字段"准备的宽容，
 * 不该被当成历史数据的长期归宿。**app 未发布，不做兼容性代码**，数据一次补齐。
 *
 * 迁移规则（确定性、可重跑、不丢字）：
 *   缺 `persona` 键 → 在 frontmatter **末尾**追加一行 `persona: <缺省人物名>`
 *   （与 createTask 的字段顺序一致：persona 排在 priority 之后）
 *   已有该键 → 原样不动（可重跑；用户手工改过也不覆盖）
 *
 * 为什么文本级手术而不是 YAML 全量重排：未命中的文件必须**逐字节不变**，
 * 命中的文件也只多一行 —— 全量 dump 会重排用户手写的自定义字段与注释。
 *
 * 用法：
 *   npx tsx scripts/migrate-add-persona.mts                  # dry-run（默认 ~/.diy）
 *   npx tsx scripts/migrate-add-persona.mts --home <dir>     # 指定数据根预演
 *   npx tsx scripts/migrate-add-persona.mts --apply          # 写盘（先备份 *.pre-persona.bak）
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { BUILTIN_PERSONA_NAME, PersonasFileSchema } from "../pkgs.ts/diy-app/src/shared/persona";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const homeIdx = args.indexOf("--home");
const HOME = (homeIdx >= 0 ? args[homeIdx + 1] : join(homedir(), ".diy"))!;

const FM = "---";

/**
 * 缺省人物名 = personas.yaml 的 `default`（指向不存在的人物则退到人物表第一个）；
 * 没有 personas.yaml 时用内置缺省（与 main 侧 core/persona.ts 的规则一致）。
 */
function defaultPersonaName(): string {
  const p = join(HOME, "personas.yaml");
  if (!existsSync(p)) return BUILTIN_PERSONA_NAME;
  try {
    const parsed = PersonasFileSchema.safeParse(yaml.load(readFileSync(p, "utf-8")));
    if (!parsed.success) return BUILTIN_PERSONA_NAME;
    const names = Object.keys(parsed.data.personas);
    if (names.length === 0) return BUILTIN_PERSONA_NAME;
    return names.includes(parsed.data.default) ? parsed.data.default : names[0]!;
  } catch {
    return BUILTIN_PERSONA_NAME;
  }
}

/** 收集 projects 下的 AGENTS.md（跳过 .diy 等点目录：那是系统自留地） */
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

interface Hit {
  uri: string;
  file: string;
  title: string;
  state: string;
}

const persona = defaultPersonaName();
const files = walk(join(HOME, "projects"));
const hits: Hit[] = [];
const already: string[] = [];
const skipped: string[] = [];

for (const file of files) {
  const raw = readFileSync(file, "utf-8");
  if (!raw.startsWith(FM)) {
    skipped.push(`${file}  (无 frontmatter)`);
    continue;
  }
  const endIdx = raw.indexOf(FM, 3);
  if (endIdx === -1) {
    skipped.push(`${file}  (frontmatter 未闭合)`);
    continue;
  }
  const fmText = raw.slice(3, endIdx);
  let front: Record<string, unknown>;
  try {
    front = (yaml.load(fmText.trim() || "{}") as Record<string, unknown>) ?? {};
  } catch (e) {
    skipped.push(`${file}  (yaml 解析失败: ${(e as Error).message})`);
    continue;
  }

  const uri = file.replace(join(HOME, "projects") + "/", "").replace("/AGENTS.md", "");
  if ("persona" in front) {
    already.push(`${uri}  (persona: ${String(front["persona"])})`);
    continue;
  }

  // 追加到 frontmatter 末尾（保留原有行序与手写内容）
  const fmBody = fmText.replace(/\n+$/, "\n");
  const out = `${FM}${fmBody}persona: ${persona}\n${FM}${raw.slice(endIdx + 3)}`;

  hits.push({ uri, file, title: String(front["title"] ?? ""), state: String(front["state"] ?? "") });

  if (APPLY) {
    copyFileSync(file, `${file}.pre-persona.bak`);
    writeFileSync(file, out, "utf-8");
  }
}

console.log(`${APPLY ? "【APPLY】" : "【DRY-RUN】"} HOME=${HOME}  缺省人物=${persona}`);
console.log(`扫描 AGENTS.md ${files.length} 个：待补 ${hits.length}、已有 persona ${already.length}、跳过 ${skipped.length}\n`);
for (const h of hits) console.log(`  + ${h.uri.padEnd(24)} [${h.state}] ${h.title.slice(0, 40)}`);
if (already.length) {
  console.log("\n已有 persona（不动）:");
  for (const a of already) console.log("  = " + a);
}
if (skipped.length) {
  console.log("\n跳过:");
  for (const s of skipped) console.log("  ! " + s);
}
if (!APPLY && hits.length) console.log(`\n未写盘。确认无误后加 --apply（会先备份 *.pre-persona.bak）`);
