// src/main/services/journal-store.ts — 任务日志（journal）存储层（##404）
//
// 形态：`<taskDir>/journal.jsonl` —— **一行一条 JSON，只追加**。
//
// 为什么 append-only：
//   · 日志的价值是「事后能查」，改它没有意义；追加语义让并发写（多轮 / 多 agent）天然安全
//   · 整文件覆盖（writeFileAtomic）要求先读全量再写，350 条历史每次写都重排一次 = 白白扩大
//     坏窗口；一条日志写坏只该坏那一条
//   · 代价：可能留下半行（进程被杀在 write 中间）。故**读时容忍坏行**（跳过 + 报 problems），
//     绝不因为一行坏掉就整份拒绝 —— 那是"一条坏行毁掉全部历史"。
//
// 与 facts 的分工（见 shared/journal.ts 头注）：journal 不做语义校验、没有 scope、不会过期。
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "../core/task";
import { taskDir, taskFilePath } from "../core/state";
import {
  JOURNAL_KINDS,
  JournalEntrySchema,
  type JournalEntry,
  type JournalKind,
  type JournalProblem,
  type JournalRow,
} from "../../shared/journal";

/**
 * 正文三选一（`--body` 内联 / `--body-text` 显式内联 / `--body-file` 文件）。
 * 多给即报错 —— 静默取一个会让"我明明写了两个"变成悬案（同 `task edit` 的口径）。
 */
export function resolveBody(
  body: string | undefined,
  bodyText: string | undefined,
  bodyFile: string | undefined,
): string | undefined {
  const given = [body, bodyText, bodyFile].filter((x): x is string => x !== undefined);
  if (given.length > 1) {
    throw new ValidationError([
      { field: "body", code: "journal/body", msg: "正文三选一：--body / --body-text / --body-file（多给即错）" },
    ]);
  }
  return given[0];
}

/** 逗号列表 → refs（空白项丢弃：`--refs a,,b` 不该炸） */
export function splitRefs(text: string): string[] {
  return text
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
}

/** kind 列表 → 枚举数组（非法值交给 validate 报，不在这里静默丢） */
export function splitKinds(text: string): JournalKind[] {
  return splitRefs(text) as JournalKind[];
}

/**
 * 导入载荷解析：接受两种历史常见形态 ——
 *   · JSON 数组（`[{kind,title,...}]`）
 *   · `{ entries: [...] }`（换个人写的导出器多半带个外壳）
 * 形状不对立刻抛，不猜。
 */
export function parseImportPayload(text: string): JournalAddInput[] {
  const doc: unknown = JSON.parse(text);
  const list: unknown = Array.isArray(doc) ? doc : (doc as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(list)) {
    throw new ValidationError([
      { field: "file", code: "journal/payload", msg: "载荷期望 `[{kind,title,...}]` 或 `{ entries: [...] }`" },
    ]);
  }
  return list.map((raw, i) => {
    const o = raw as Record<string, unknown>;
    const errs: { field: string; code: string; msg: string }[] = [];
    if (typeof o["kind"] !== "string") errs.push({ field: "kind", code: "journal/kind", msg: `第 ${i + 1} 条缺 kind` });
    if (typeof o["title"] !== "string") errs.push({ field: "title", code: "journal/title", msg: `第 ${i + 1} 条缺 title` });
    // error-code-ok: 字段级 code 在 errors 载荷里（journal/kind / journal/title / journal/ts），不进 err.code
  if (errs.length > 0) throw new ValidationError(errs);
    return {
      kind: o["kind"] as JournalKind,
      title: o["title"] as string,
      ...(typeof o["body"] === "string" ? { body: o["body"] } : {}),
      ...(Array.isArray(o["refs"]) ? { refs: o["refs"].map(String) } : {}),
      ...(typeof o["round"] === "string" ? { round: o["round"] } : {}),
      ...(typeof o["ts"] === "string" ? { ts: o["ts"] } : {}),
    };
  });
}

/** 标题上限：不是硬规则，是"写不出短标题 = 这条该拆"的提示（超了不拒，CLI 只提醒） */
export const TITLE_SOFT_LIMIT = 120;

export function journalFile(taskUri: string): string {
  return join(taskDir(taskUri), "journal.jsonl");
}

/** 任务存在才允许写 —— 打错 uri 立刻报错，而不是在 `~/.diy` 里造一棵孤儿目录 */
function requireTask(taskUri: string): void {
  if (!existsSync(taskFilePath(taskUri))) {
    throw new ValidationError([{ field: "task", code: "task/not-found", msg: `任务不存在：${taskUri}` }]);
  }
}

export interface JournalAddInput {
  readonly kind: JournalKind;
  readonly title: string;
  readonly body?: string;
  readonly refs?: readonly string[];
  readonly round?: string;
  /** 仅在回灌历史时给（缺省 = 现在） */
  readonly ts?: string;
}

function validateOne(input: JournalAddInput, index: number): JournalEntry {
  const where = index >= 0 ? `第 ${index + 1} 条` : "条目";
  const errs: { field: string; code: string; msg: string }[] = [];
  if (!JOURNAL_KINDS.includes(input.kind)) {
    errs.push({ field: "kind", code: "journal/kind", msg: `${where}.kind 必须是 ${JOURNAL_KINDS.join(" | ")}` });
  }
  const title = input.title.trim();
  if (title === "") errs.push({ field: "title", code: "journal/title", msg: `${where}.title 必填（一行标题）` });
  // 标题必须真的是一行：多行标题会破坏渲染与「按标题扫一遍」的用法
  if (/[\r\n]/.test(title)) errs.push({ field: "title", code: "journal/title", msg: `${where}.title 不得含换行` });
  if (input.ts !== undefined && Number.isNaN(Date.parse(input.ts))) {
    errs.push({ field: "ts", code: "journal/ts", msg: `${where}.ts 不是合法时间：${input.ts}` });
  }
  // error-code-ok: 字段级 code 在 errors 载荷里（journal/kind / journal/title / journal/ts），不进 err.code
  if (errs.length > 0) throw new ValidationError(errs);

  const parsed = JournalEntrySchema.safeParse({
    ts: input.ts ?? new Date().toISOString(),
    kind: input.kind,
    title,
    ...(input.body === undefined || input.body === "" ? {} : { body: input.body }),
    ...(input.refs === undefined || input.refs.length === 0 ? {} : { refs: [...input.refs] }),
    task: "",
    ...(input.round === undefined ? {} : { round: input.round }),
  });
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => ({ field: i.path.join("."), code: "journal/schema", msg: i.message })),
    );
  }
  return parsed.data;
}

export interface ReadReport {
  readonly rows: readonly JournalRow[];
  readonly problems: readonly JournalProblem[];
  readonly bytes: number;
}

/** 读全量（seq = 行号 1-based；坏行占号但不产生 row —— 号是文件里的物理行，可据此 `sed -n` 定位） */
export function readJournal(taskUri: string): ReadReport {
  const file = journalFile(taskUri);
  if (!existsSync(file)) return { rows: [], problems: [], bytes: 0 };
  const text = readFileSync(file, "utf8");
  const rows: JournalRow[] = [];
  const problems: JournalProblem[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    try {
      const obj: unknown = JSON.parse(line);
      const parsed = JournalEntrySchema.safeParse(obj);
      if (!parsed.success) {
        problems.push({ seq: i + 1, detail: `形状不符：${parsed.error.issues.map((x) => x.path.join(".")).join(",")}` });
        continue;
      }
      rows.push({ ...parsed.data, seq: i + 1 });
    } catch (e) {
      problems.push({ seq: i + 1, detail: `不是合法 JSON：${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return { rows, problems, bytes: statSync(file).size };
}

/** 追加（全量校验先于任何写入：一条不过，磁盘不动） */
export function addEntries(
  taskUri: string,
  inputs: readonly JournalAddInput[],
): { task: string; added: JournalRow[]; total: number } {
  requireTask(taskUri);
  if (inputs.length === 0) return { task: taskUri, added: [], total: readJournal(taskUri).rows.length };
  const entries = inputs.map((input, i) => validateOne(input, i));

  const file = journalFile(taskUri);
  mkdirSync(taskDir(taskUri), { recursive: true });
  // 单次追加所有行：一行一个 write 会在中途失败时留下"写了一半的批次"（日志没有事务可言，
  // 但"批次要么都在要么都不在"这条还是值得守 —— 一次 write 一个 buffer 即可）。
  const payload = entries.map((e) => `${JSON.stringify({ ...e, task: taskUri })}\n`).join("");
  appendFileSync(file, payload, "utf8");

  const after = readJournal(taskUri);
  const added = [...after.rows.slice(after.rows.length - entries.length)];
  return { task: taskUri, added, total: after.rows.length };
}

/** 批量导入（回灌历史用）：**整批校验通过才写**，`dryRun` 只算 */
export function importEntries(
  taskUri: string,
  items: readonly JournalAddInput[],
  dryRun: boolean,
): { task: string; dryRun: boolean; accepted: number; rejected: number; errors: { index: number; detail: string }[] } {
  requireTask(taskUri);
  const errors: { index: number; detail: string }[] = [];
  items.forEach((item, i) => {
    try {
      validateOne(item, i);
    } catch (e) {
      errors.push({ index: i, detail: e instanceof Error ? e.message : String(e) });
    }
  });
  if (errors.length > 0) return { task: taskUri, dryRun, accepted: 0, rejected: items.length, errors };
  if (!dryRun && items.length > 0) addEntries(taskUri, items);
  return { task: taskUri, dryRun, accepted: items.length, rejected: 0, errors: [] };
}

export interface FindFilter {
  readonly kind?: readonly JournalKind[];
  /** ISO 日期或完整时间；含 `--since 2026-10-21` 这种日粒度 */
  readonly since?: string;
  readonly until?: string;
  /** 子串（大小写不敏感），搜 title / body / refs */
  readonly grep?: string;
  readonly limit?: number;
  readonly order?: "asc" | "desc";
}

function parseBound(text: string, label: string): number {
  const t = Date.parse(text);
  if (Number.isNaN(t)) throw new ValidationError([{ field: label, code: "journal/bound", msg: `${label} 不是合法时间：${text}` }]);
  return t;
}

export function findJournal(
  taskUri: string,
  filter: FindFilter = {},
): { task: string; total: number; matched: number; rows: JournalRow[]; text: string; problems: JournalProblem[] } {
  const all = readJournal(taskUri);
  const since = filter.since === undefined ? null : parseBound(filter.since, "since");
  const until = filter.until === undefined ? null : parseBound(filter.until, "until");
  const needle = filter.grep?.toLowerCase();
  const kinds = filter.kind && filter.kind.length > 0 ? new Set(filter.kind) : null;

  const matched = all.rows.filter((r) => {
    if (kinds !== null && !kinds.has(r.kind)) return false;
    const t = Date.parse(r.ts);
    if (since !== null && t < since) return false;
    if (until !== null && t > until) return false;
    if (needle !== undefined) {
      const hay = [r.title, r.body ?? "", ...(r.refs ?? [])].join("\n").toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  const ordered = filter.order === "asc" ? matched : [...matched].reverse();
  const limited = filter.limit === undefined || filter.limit < 0 ? ordered : ordered.slice(0, filter.limit);
  return {
    task: taskUri,
    total: all.rows.length,
    matched: matched.length,
    rows: [...limited],
    text: limited.map(renderRow).join("\n\n"),
    problems: [...all.problems],
  };
}

export function renderRow(row: JournalRow): string {
  const when = row.ts.replace("T", " ").slice(0, 16);
  const head = `### #${row.seq} · ${when} · ${row.kind} · ${row.title}`;
  const parts = [head];
  if (row.body !== undefined && row.body !== "") parts.push(row.body.trim());
  if (row.refs !== undefined && row.refs.length > 0) parts.push(`refs: ${row.refs.map((r) => `\`${r}\``).join(" · ")}`);
  return parts.join("\n");
}

export function journalStats(taskUri: string): {
  task: string;
  total: number;
  bytes: number;
  byKind: Record<JournalKind, number>;
  first: string | null;
  last: string | null;
  problems: JournalProblem[];
} {
  const all = readJournal(taskUri);
  const byKind = Object.fromEntries(JOURNAL_KINDS.map((k) => [k, 0])) as Record<JournalKind, number>;
  for (const r of all.rows) byKind[r.kind] += 1;
  const times = all.rows.map((r) => r.ts).sort();
  return {
    task: taskUri,
    total: all.rows.length,
    bytes: all.bytes,
    byKind,
    first: times[0] ?? null,
    last: times.length > 0 ? times[times.length - 1]! : null,
    problems: [...all.problems],
  };
}
