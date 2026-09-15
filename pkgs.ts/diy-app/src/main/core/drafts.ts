// src/main/core/drafts.ts
// 🎯 半编辑草稿（ui drafts）— 用户尚未提交的输入，落到任务目录的 .diy/drafts.yaml
//
// 为什么不是 cache：草稿是**用户输入**，丢失 = 用户白打，不可重建。
// 判据（可重建性）：
//   可重建                  → localStorage（视图 cache，见 renderer_solid/lib/ui-state.ts）
//   不可重建 + 小体量       → 任务目录 .diy/（本文件）
//   不可重建 + 大体量/日志型 → $DIY_HOME/local/（agent 的 ops/llm jsonl）
//
// 为什么不做成浏览器存储：serve 模式与 Electron 模式各有独立 localStorage，
// 同一条草稿在另一个模式看不到；落任务目录则两模式共用同一份。
//
// 生命周期随任务目录：deleteTask 是 rmSync(dir, {recursive:true})，草稿自然随删。
//
// 文件格式（带 meta，与 AGENTS.md 的 frontmatter 同风格）：
//   ---
//   kind: diy.ui-drafts
//   version: 1
//   task: projects/4/tasks/113
//   base_updated: <草稿落盘时 AGENTS.md 的 updated>   ← 判定草稿是否已过期
//   saved: <落盘时间>
//   ---
//   fields:
//     title: 半编辑的标题
//     agent_input: |
//       打到一半的话

import * as yaml from "js-yaml";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { taskSystemDir } from "./state";

/** 文件格式标识（写时写入、读时校验，防止误读别的 yaml） */
export const DRAFTS_KIND = "diy.ui-drafts";
/** 格式版本。丢不起的数据：演进时宁可转换/报错，不许静默回默认值（与 cache 策略相反） */
export const DRAFTS_VERSION = 1;

/**
 * 草稿字段名白名单。
 * 加字段必须同时改这里 —— 防止前端拼错字段名后静默写进文件（读侧永远读不出来）。
 * body 也允许存（编辑器可能改正文）。
 */
export const DRAFT_FIELDS = ["title", "detail", "body", "agent_input"] as const;
export type DraftField = (typeof DRAFT_FIELDS)[number];

export interface DraftsFile {
  /** 草稿落盘时 AGENTS.md 的 updated。用于检测「草稿期间任务被外部改过」 */
  base_updated?: string;
  saved?: string;
  fields: Partial<Record<DraftField, string>>;
}

export interface ParsedDrafts extends DraftsFile {
  kind: string;
  version: number;
  task: string;
}

export function draftsFilePath(uri: string): string {
  return join(taskSystemDir(uri), "drafts.yaml");
}

function isDraftField(k: string): k is DraftField {
  return (DRAFT_FIELDS as readonly string[]).includes(k);
}

/**
 * 拆出入参里的「写入」与「清除」两组字段。
 *
 * 空串的语义是**清除该字段**（不是写入空串）：调用方「清空输入框」时传 "" 即可，
 * 不必区分 clear/set 两个接口。故此处返回两个集合而非单个。
 */
function splitFields(fields: Partial<Record<DraftField, string>>): {
  sets: Partial<Record<DraftField, string>>;
  removes: DraftField[];
} {
  const sets: Partial<Record<DraftField, string>> = {};
  const removes: DraftField[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v !== "string") continue;
    if (!isDraftField(k)) {
      // 拼错字段名会让草稿「写进去但永远读不出来」，必须出声
      console.warn(`[drafts] 忽略未知字段 ${k}（白名单见 DRAFT_FIELDS）`);
      continue;
    }
    if (v === "") removes.push(k);
    else sets[k] = v;
  }
  return { sets, removes };
}

/**
 * 读取草稿。文件不存在 → null；格式非法（kind/version 不符、yaml 解析失败）→ null + 留痕。
 *
 * 非法时返回 null 而不是抛错：草稿是尽力而为的恢复手段，读失败不该阻断 UI 打开任务。
 * 但必须留痕 —— 静默吞掉会让「草稿莫名消失」无从排查。
 */
export function readDrafts(uri: string): ParsedDrafts | null {
  const fp = draftsFilePath(uri);
  if (!existsSync(fp)) return null;
  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(fp, "utf-8"));
  } catch (e) {
    console.warn(`[drafts] yaml 解析失败，忽略 ${fp}:`, e);
    return null;
  }
  if (!raw || typeof raw !== "object") {
    console.warn(`[drafts] 内容非对象，忽略 ${fp}`);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (obj["kind"] !== DRAFTS_KIND) {
    console.warn(`[drafts] kind 不符（${String(obj["kind"])}），忽略 ${fp}`);
    return null;
  }
  const version = Number(obj["version"]);
  if (version !== DRAFTS_VERSION) {
    // 丢不起的数据：不静默降级，明确告知（将来在此加迁移）
    console.warn(
      `[drafts] 版本 ${String(obj["version"])} 与当前 ${DRAFTS_VERSION} 不符，忽略 ${fp}`,
    );
    return null;
  }
  const rawFields = obj["fields"];
  const fields: Partial<Record<DraftField, string>> = {};
  if (rawFields && typeof rawFields === "object") {
    for (const [k, v] of Object.entries(rawFields as Record<string, unknown>)) {
      if (typeof v === "string" && isDraftField(k) && v !== "") fields[k] = v;
    }
  }
  return {
    kind: DRAFTS_KIND,
    version,
    task: String(obj["task"] ?? uri),
    base_updated: obj["base_updated"] === undefined ? undefined : String(obj["base_updated"]),
    saved: obj["saved"] === undefined ? undefined : String(obj["saved"]),
    fields,
  };
}

/**
 * 写入草稿（合并语义：只覆盖传入字段，未传字段保持原值）。
 *
 * - fields 全空 → 删除文件（不留空壳）
 * - 原子写（tmp + rename）：读取方永不见半文件
 * - 失败**抛错**（不静默）：半编辑数据丢失必须让调用方看到并提示用户
 */
export function writeDrafts(
  uri: string,
  fields: Partial<Record<DraftField, string>>,
  baseUpdated?: string,
): DraftsFile {
  const { sets, removes } = splitFields(fields);
  const existing = readDrafts(uri);
  const merged: Partial<Record<DraftField, string>> = { ...existing?.fields, ...sets };
  for (const f of removes) delete merged[f];
  return persist(uri, merged, existing?.base_updated ?? baseUpdated);
}

/**
 * 整表替换落盘（不做合并）。
 * 合并语义只在 writeDrafts 层；清除路径必须走这里，否则「删掉的字段」会被
 * 合并逻辑从磁盘旧值里又捞回来。
 */
function persist(
  uri: string,
  fields: Partial<Record<DraftField, string>>,
  baseUpdated?: string,
): DraftsFile {
  const fp = draftsFilePath(uri);
  if (Object.keys(fields).length === 0) {
    rmSync(fp, { force: true });
    return { fields: {} };
  }
  const now = new Date().toISOString();
  const body: ParsedDrafts = {
    kind: DRAFTS_KIND,
    version: DRAFTS_VERSION,
    task: uri,
    // 已有 base_updated 优先保留：草稿的「基点」是首次落盘时的任务版本
    base_updated: baseUpdated,
    saved: now,
    fields,
  };
  mkdirSync(taskSystemDir(uri), { recursive: true });
  const tmp = fp + ".tmp";
  writeFileSync(tmp, yaml.dump(body, { indent: 2, noRefs: true, lineWidth: 120 }), "utf-8");
  renameSync(tmp, fp);
  return { base_updated: body.base_updated, saved: now, fields };
}

/**
 * 清除草稿。传 fields 只清指定字段（清完为空则删文件），不传则整个删除。
 * 幂等：文件不存在不报错。
 */
export function clearDrafts(uri: string, fields?: DraftField[]): void {
  const fp = draftsFilePath(uri);
  if (!fields || fields.length === 0) {
    rmSync(fp, { force: true });
    return;
  }
  const existing = readDrafts(uri);
  if (!existing) return;
  const remaining = { ...existing.fields };
  for (const f of fields) delete remaining[f];
  persist(uri, remaining, existing.base_updated);
}
