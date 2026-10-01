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
export const DRAFTS_VERSION = 3;

/**
 * 草稿字段名白名单。
 * 加字段必须同时改这里 —— 防止前端拼错字段名后静默写进文件（读侧永远读不出来）。
 */
export const DRAFT_FIELDS = ["title", "body", "agent_input"] as const;
export type DraftField = (typeof DRAFT_FIELDS)[number];

/**
 * 插话（steer）的投递时机 —— 差别只在**投递点**，不在条数：
 *   next-step = 下一个模型步边界之前（本轮内就生效）
 *   next-turn = 本轮收尾后的下一轮开场
 * 两者都是整批投：一次把队列里剩下的全部取出（多条合并成同一批），
 * 排队多条的心愿就是"一起告诉它"。
 */
export const STEER_MODES = ["next-step", "next-turn"] as const;
export type SteerMode = (typeof STEER_MODES)[number];

/**
 * 历史 mode 值 → 现值。
 *
 * 枚举最初叫 `step` / `turn`，后改名成 `next-step` / `next-turn`（词表与 dsh 的两个 inbox 对齐）。
 * 改名**没有**升 DRAFTS_VERSION，于是旧文件里的 `mode: step` 会撞上 parseSteers 的
 * "未知模式 → 丢弃"分支 —— 排队中的留言凭空消失（实测复现）。这是「丢了 = 用户白打」的数据，
 * 读侧必须兼容：映射不了的才丢。
 *
 * 与 LEGACY_DENSITY（1-4 → 语义值）同一手法：兼容放在**读**侧，写侧永远只写现值。
 */
const LEGACY_STEER_MODE: Record<string, SteerMode> = {
  step: "next-step",
  turn: "next-turn",
};

/**
 * 一条「已提交但尚未投递给模型」的插话 —— 也就是草稿机制里的第二份、第三份草稿。
 *
 * 为什么与草稿同文件：两者同属「用户输入，丢了 = 用户白打，不可重建」，
 * 生命周期也完全一致（随任务目录删除）。差别只在草稿尚未提交、插话已提交待投递。
 * 顺序即 FIFO 投递顺序（文本本身就是消息，不可重排、不可静默丢弃）。
 */
export interface SteerItem {
  /** 队列内唯一 id，形如 `steer/1`（"实体/序号"；取消定位 / 渲染 key / CLI 参数） */
  id: string;
  mode: SteerMode;
  text: string;
  /** 入队时间（ISO） */
  created: string;
}

/**
 * 版本迁移表：旧版本号 → 升级函数（返回新对象，version 必须变成下一版）。
 *
 * v1 → v2：字段 detail 下线（任务模型只有 title + 内容，detail 是历史遗留的同义槽）。
 *          草稿里的 detail 无处安放，直接丢弃；其余字段原样保留（丢不起的是别的字段）。
 * v2 → v3：新增 steers（已提交待投递的插话队列）。纯增字段，无信息损失（缺省空数组）。
 * 无法迁移的版本 → readDrafts 返回 null 并留痕（不静默降级）。
 */
const MIGRATIONS: Record<number, (o: Record<string, unknown>) => Record<string, unknown>> = {
  1: (o) => {
    const fields: Record<string, unknown> = { ...(o["fields"] as Record<string, unknown> | undefined) };
    delete fields["detail"];
    return { ...o, version: 2, fields };
  },
  2: (o) => ({ ...o, version: 3 }),
};

export interface DraftsFile {
  /** 草稿落盘时 AGENTS.md 的 updated。用于检测「草稿期间任务被外部改过」 */
  base_updated?: string;
  saved?: string;
  fields: Partial<Record<DraftField, string>>;
  /** 已提交待投递的插话队列（FIFO）。空 = 无；写侧可省 */
  steers?: SteerItem[];
}

export interface ParsedDrafts extends DraftsFile {
  kind: string;
  version: number;
  task: string;
  /** 读侧恒为数组（缺省 = 空队列），调用方不必再做 null 判断 */
  steers: SteerItem[];
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
  // 版本迁移：能迁的升到当前版本（值仍在内存，下次落盘即为新版）；不能迁的忽略并留痕。
  // 丢不起的数据不静默降级 —— 但「明确的、有损可查的迁移」比直接丢弃整份草稿好。
  let version = Number(obj["version"]);
  let guard = 0;
  while (version !== DRAFTS_VERSION) {
    const migrate = MIGRATIONS[version];
    if (!migrate || guard++ > 16) {
      console.warn(
        `[drafts] 版本 ${String(obj["version"])} 无法迁移到 ${DRAFTS_VERSION}，忽略 ${fp}`,
      );
      return null;
    }
    Object.assign(obj, migrate(obj));
    version = Number(obj["version"]);
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
    steers: parseSteers(obj["steers"]),
  };
}

/**
 * 解析插话队列。结构不完整的项**跳过并留痕**（不抛错）：
 * 一条坏记录不该让整个任务的草稿/队列都读不出来；但静默吞掉会让「插话莫名消失」无从排查。
 */
function parseSteers(raw: unknown): SteerItem[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) console.warn("[drafts] steers 不是数组，按空队列处理");
    return [];
  }
  const out: SteerItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      console.warn("[drafts] 忽略非对象的插话项");
      continue;
    }
    const o = item as Record<string, unknown>;
    // 先过历史值映射（step/turn → next-step/next-turn），再做合法性校验
    const rawMode = String(o["mode"] ?? "");
    const mode = LEGACY_STEER_MODE[rawMode] ?? rawMode;
    // trim 后为空也算空：add 侧拒空靠 trim（steer-queue），读侧不设防就会出现
    // "手写进文件的空白插话" —— 它投出去只会污染提示词（同一条不变式，两侧都要守）
    if (typeof o["id"] !== "string" || typeof o["text"] !== "string" || o["text"].trim() === "") {
      console.warn("[drafts] 忽略结构不完整的插话项（需要 id + 非空白 text）");
      continue;
    }
    if (!(STEER_MODES as readonly string[]).includes(mode)) {
      console.warn(`[drafts] 忽略未知插话模式 ${mode}（合法值：${STEER_MODES.join("/")}）`);
      continue;
    }
    out.push({
      id: o["id"],
      mode: mode as SteerMode,
      text: o["text"],
      created: typeof o["created"] === "string" ? o["created"] : "",
    });
  }
  return out;
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
  return persist(uri, { fields: merged, steers: existing?.steers ?? [] }, existing?.base_updated ?? baseUpdated);
}

/**
 * 写入插话队列（整表替换：队列是 FIFO，合并语义没有意义且会打乱顺序）。
 *
 * 保留同文件的草稿字段与 base_updated —— 两类数据同文件但互不干涉，
 * 谁写谁只动自己那一块（否则"提交插话"会顺手清掉用户正在打的草稿）。
 */
export function writeSteers(uri: string, steers: SteerItem[]): SteerItem[] {
  const existing = readDrafts(uri);
  persist(uri, { fields: existing?.fields ?? {}, steers }, existing?.base_updated);
  return steers;
}

/**
 * 整表替换落盘（不做合并）。
 * 合并语义只在 writeDrafts 层；清除路径必须走这里，否则「删掉的字段」会被
 * 合并逻辑从磁盘旧值里又捞回来。
 *
 * 空（既无字段又无队列）→ 删文件，不留空壳。
 */
function persist(
  uri: string,
  data: { fields: Partial<Record<DraftField, string>>; steers: SteerItem[] },
  baseUpdated?: string,
): DraftsFile {
  const fp = draftsFilePath(uri);
  const { fields, steers } = data;
  if (Object.keys(fields).length === 0 && steers.length === 0) {
    rmSync(fp, { force: true });
    return { fields: {}, steers: [] };
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
    steers,
  };
  mkdirSync(taskSystemDir(uri), { recursive: true });
  const tmp = fp + ".tmp";
  writeFileSync(tmp, yaml.dump(body, { indent: 2, noRefs: true, lineWidth: 120 }), "utf-8");
  renameSync(tmp, fp);
  return { base_updated: body.base_updated, saved: now, fields, steers };
}

/**
 * 清除草稿字段。传 fields 只清指定字段，不传则清空全部字段。
 *
 * 只清 `fields`，**不动 steers**：插话队列是另一类数据（已提交、待投递），
 * 「清空输入框草稿」不该顺手把排队中的插话也删掉。整份文件只在两者皆空时删除。
 * 幂等：文件不存在不报错。
 *
 * 语义边界（与旧版不同，见 tests/core/drafts.test.ts 锁定）：
 *   · 不传 fields          → 清空全部**字段**（队列保留）
 *   · 传 ['title']         → 只清 title
 *   · 传 []                → **什么都不清**（"按列出的字段清空"的中性结果）
 * 旧版把空数组当"整份删除"，那正是引入 steers 后**必须**改掉的行为 ——
 * 否则 CLI 传一次空数组就把用户排队中的插话一起删了。
 */
export function clearDrafts(uri: string, fields?: DraftField[]): void {
  const existing = readDrafts(uri);
  if (!existing) return;
  const remaining = { ...existing.fields };
  const targets = fields ?? (Object.keys(remaining) as DraftField[]);
  for (const f of targets) delete remaining[f];
  persist(uri, { fields: remaining, steers: existing.steers }, existing.base_updated);
}
