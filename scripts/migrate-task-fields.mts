#!/usr/bin/env npx tsx
/**
 * 一次性数据迁移：任务 AGENTS.md 字段整理
 *
 *   ① detail → 并入 body（同义的第二内容槽下线）
 *   ② 删除 project 字段（URI 即路径，是计算值，不该落盘）
 *
 * 背景：任务模型只有「标题 + 内容」两个内容字段，但历史上有两个同义内容槽：
 *   detail（frontmatter 内的 YAML 字段）← 旧 Python 栈 create_task(detail=…) 写入
 *   body （frontmatter 之后的 markdown 正文）← agent 直接写文件时落在这
 * 用哪个是随机的，且 UI 只读 detail（编辑框）却渲染 detail + body 两节 ——
 * 于是「页面有内容、点编辑是空框、保存后内容出现两份」。
 *
 * 迁移规则（确定性、可重跑、不丢字）：
 *   ① detail 有内容、body 为空 → body = detail
 *      detail 有内容、body 也有 → body = detail + "\n\n" + body（detail 作开头段落）
 *      detail 空/空白            → 只删字段
 *   ② project 一律删除（无论值是否与路径一致；路径是唯一真相源）
 *   其余内容逐字节保留：只在 frontmatter 文本里做「摘键」手术，不做 YAML 全量重排，
 *   避免整文件 diff 噪音，也避免误动用户自定义字段。
 *
 * 用法：
 *   npx tsx scripts/migrate-task-fields.mts [--home ~/.diy] [--apply]
 *   默认 dry-run（只打印将改动的任务与前后摘要）；--apply 才写盘，且先备份 *.pre-migrate.bak
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as yaml from "js-yaml";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const homeIdx = args.indexOf("--home");
const HOME = (homeIdx >= 0 ? args[homeIdx + 1] : join(homedir(), ".diy"))!;

const FM = "---";

interface Hit {
  uri: string;
  file: string;
  detailLen: number;
  bodyLen: number;
  detailMode: string;
  hadProject: string;
  before: string;
  after: string;
}

/**
 * 从 frontmatter 文本中摘除某个键（含其块标量续行 / 数组项），返回新文本。
 * 文本级手术，不重排其余行。
 */
function stripKey(fmText: string, key: string): string {
  const lines = fmText.split("\n");
  const out: string[] = [];
  const head = new RegExp(`^${key}:`);
  let i = 0;
  while (i < lines.length) {
    if (head.test(lines[i]!)) {
      i++;
      // 吃掉该键的续行：缩进行，以及「后面还跟着缩进行」的空行
      while (i < lines.length) {
        const l = lines[i]!;
        if (/^\s/.test(l)) {
          i++;
          continue;
        }
        if (l.trim() === "") {
          let j = i + 1;
          while (j < lines.length && lines[j]!.trim() === "") j++;
          if (j < lines.length && /^\s/.test(lines[j]!)) {
            i = j;
            continue;
          }
        }
        break;
      }
      continue;
    }
    out.push(lines[i]!);
    i++;
  }
  return out.join("\n");
}

/** 收集 projects 下所有 AGENTS.md */
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

const files = walk(join(HOME, "projects"));
const hits: Hit[] = [];
const skipped: string[] = [];

for (const file of files) {
  const raw = readFileSync(file, "utf-8");
  if (!raw.startsWith(FM)) {
    skipped.push(file + "  (无 frontmatter)");
    continue;
  }
  const endIdx = raw.indexOf(FM, 3);
  if (endIdx === -1) {
    skipped.push(file + "  (frontmatter 未闭合)");
    continue;
  }
  const fmText = raw.slice(3, endIdx);
  const afterSep = raw.slice(endIdx + 3);

  let front: Record<string, unknown>;
  try {
    front = (yaml.load(fmText.trim() || "{}") as Record<string, unknown>) ?? {};
  } catch (e) {
    skipped.push(file + `  (yaml 解析失败: ${(e as Error).message})`);
    continue;
  }

  const hasDetail = "detail" in front;
  const hasProject = "project" in front;
  if (!hasDetail && !hasProject) continue;

  const detail = typeof front["detail"] === "string" ? front["detail"] : "";
  const dTrim = detail.trim();
  const body = afterSep.replace(/^\n+/, "").replace(/\s+$/, "");

  let newBody = body;
  let mode = "（无 detail）";
  if (hasDetail) {
    if (dTrim === "") {
      newBody = body;
      mode = "空 detail → 仅删字段";
    } else if (body === "") {
      newBody = dTrim;
      mode = "detail → body";
    } else {
      newBody = dTrim + "\n\n" + body;
      mode = "detail 前置进 body";
    }
  }

  let fmNew = fmText;
  if (hasDetail) fmNew = stripKey(fmNew, "detail");
  if (hasProject) fmNew = stripKey(fmNew, "project");
  fmNew = fmNew.replace(/\n{2,}/g, "\n").replace(/\n+$/, "\n");

  const out = `${FM}${fmNew}${FM}\n${newBody ? newBody + "\n" : ""}`;
  const uri = file.replace(join(HOME, "projects") + "/", "").replace("/AGENTS.md", "");

  hits.push({
    uri,
    file,
    detailLen: dTrim.length,
    bodyLen: body.length,
    detailMode: mode,
    hadProject: hasProject ? String(front["project"]) : "—",
    before: body.slice(0, 56).replace(/\n/g, "⏎"),
    after: newBody.slice(0, 56).replace(/\n/g, "⏎"),
  });

  if (APPLY) {
    copyFileSync(file, file + ".pre-migrate.bak");
    writeFileSync(file, out, "utf-8");
  }
}

const hasDetailCount = hits.filter((h) => h.detailMode !== "（无 detail）").length;
const hasProjectCount = hits.filter((h) => h.hadProject !== "—").length;

console.log(`${APPLY ? "【APPLY】" : "【DRY-RUN】"} HOME=${HOME}`);
console.log(`扫描 AGENTS.md ${files.length} 个；命中待处理 ${hits.length} 个`);
console.log(`  含 detail : ${hasDetailCount}`);
console.log(`  含 project: ${hasProjectCount}\n`);
console.log("uri".padEnd(24) + "detail".padStart(7) + "body".padStart(7) + "  project".padEnd(10) + " 模式");
for (const h of hits) {
  console.log(
    h.uri.padEnd(24) +
      String(h.detailLen).padStart(7) +
      String(h.bodyLen).padStart(7) +
      ("  " + h.hadProject).padEnd(10) +
      " " +
      h.detailMode,
  );
}

console.log("\n── 抽样前后对比 ──");
for (const h of hits.filter((x) => x.detailMode !== "（无 detail）").slice(0, 4)) {
  console.log(`\n[${h.uri}]`);
  console.log("  前: " + (h.before || "(空)"));
  console.log("  后: " + (h.after || "(空)"));
}
if (skipped.length) {
  console.log("\n跳过:");
  for (const s of skipped) console.log("  " + s);
}
if (!APPLY) console.log(`\n未写盘。确认无误后加 --apply（会先备份 *.pre-migrate.bak）`);
