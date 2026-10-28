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
import { docRangeAnchor, messageAnchor, nodeAnchor, parseAnchor, taskFieldAnchor, type Anchor } from "@diy/talk";
import {
  JOURNAL_AUTHOR_ROLES,
  JOURNAL_KINDS,
  JournalEntrySchema,
  type JournalAuthor,
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
 * `--author <role>[:<name>]` → `{role, name?}`。
 *
 * 例：`system` / `agent:main` / `human:chen56`。
 * 名字里允许再出现冒号（`agent:sub:worker`），只按**第一个**冒号切。
 */
export function parseAuthorSpec(text: string): JournalAuthor {
  const idx = text.indexOf(":");
  const role = (idx < 0 ? text : text.slice(0, idx)).trim();
  const name = idx < 0 ? "" : text.slice(idx + 1).trim();
  if (!(JOURNAL_AUTHOR_ROLES as readonly string[]).includes(role)) {
    throw new ValidationError([
      { field: "author", code: "journal/author-role", msg: `--author 的 role 必须是 ${JOURNAL_AUTHOR_ROLES.join(" | ")}（收到 ${JSON.stringify(role)}）` },
    ]);
  }
  return name === "" ? { role: role as JournalAuthor["role"] } : { role: role as JournalAuthor["role"], name };
}

/**
 * `--anchor <type>:<...>` → `@diy/talk` 的 Anchor。
 *
 *   node:<nodeId>
 *   message:<messageId>
 *   task-field:<field>
 *   doc-range:<revisionId>:<offset>:<quote>   ← 只按前两个冒号切，quote 里可以有冒号
 *
 * **不提供"从当前上下文猜锚点"**：猜出来的锚点比没有更糟（指向错的东西还没人发现）。
 */
export function parseAnchorSpec(text: string): Anchor {
  const idx = text.indexOf(":");
  const type = idx < 0 ? text.trim() : text.slice(0, idx).trim();
  const rest = idx < 0 ? "" : text.slice(idx + 1);
  const need = (value: string, hint: string): string => {
    if (value.trim() === "") {
      throw new ValidationError([{ field: "anchor", code: "journal/anchor-spec", msg: `--anchor ${type} 缺少 ${hint}` }]);
    }
    return value.trim();
  };
  switch (type) {
    case "node":
      return nodeAnchor(need(rest, "<nodeId>"));
    case "message":
      return messageAnchor(need(rest, "<messageId>"));
    case "task-field":
      return taskFieldAnchor(need(rest, "<field>"));
    case "doc-range": {
      const a = rest.indexOf(":");
      const b = a < 0 ? -1 : rest.indexOf(":", a + 1);
      if (a < 0 || b < 0) {
        throw new ValidationError([
          { field: "anchor", code: "journal/anchor-spec", msg: "--anchor doc-range 需要 <revisionId>:<offset>:<quote>" },
        ]);
      }
      const revisionId = need(rest.slice(0, a), "<revisionId>");
      const offsetText = rest.slice(a + 1, b).trim();
      const offset = Number(offsetText);
      if (!Number.isInteger(offset) || offset < 0) {
        throw new ValidationError([
          { field: "anchor", code: "journal/anchor-spec", msg: `--anchor doc-range 的 offset 必须是非负整数（收到 ${JSON.stringify(offsetText)}）` },
        ]);
      }
      return docRangeAnchor(revisionId, offset, need(rest.slice(b + 1), "<quote>"));
    }
    default:
      throw new ValidationError([
        { field: "anchor", code: "journal/anchor-spec", msg: `--anchor 类型必须是 node | message | task-field | doc-range（收到 ${JSON.stringify(type)}）` },
      ]);
  }
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
  /** 谁写的（决定能否当证据；缺省 = 未标，**不默认成 agent**） */
  readonly author?: JournalAuthor;
  /** 指向哪（`@diy/talk` 的 Anchor 形状；写入时经 parseAnchor 规范化） */
  readonly anchor?: Anchor;
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
  // 锚点：形状错在这里就拦住（z.custom 只保证 isAnchor，规范化交给 parseAnchor）
  let anchor: Anchor | undefined;
  if (input.anchor !== undefined) {
    try {
      anchor = parseAnchor(input.anchor);
    } catch (e) {
      errs.push({ field: "anchor", code: "journal/anchor", msg: `${where}.anchor 非法：${e instanceof Error ? e.message : String(e)}` });
    }
  }
  // human 必须带 anchor —— 否则无法区分「用户真说过」与「模型替他说」。
  // 这是 author 三态唯一硬约束：宁可不记，不许伪造来源。
  if (input.author?.role === "human" && anchor === undefined) {
    errs.push({
      field: "author.anchor",
      code: "journal/author-anchor",
      msg: `${where} author.role=human 必须带 anchor（message / doc-range / task-field / node 任一）`,
    });
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
    ...(input.author === undefined ? {} : { author: input.author }),
    ...(anchor === undefined ? {} : { anchor }),
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

export interface SystemEventInput {
  /** 归一化 code（`llm/step-limit` 这类）；**同时是去重键** */
  readonly code: string;
  /** 一行标题（不含 code 前缀，本函数自己加） */
  readonly title: string;
  readonly body?: string;
  /** kind 缺省 `pitfall`：系统事件几乎都是「出了事」，少数里程碑由调用方改传 */
  readonly kind?: JournalKind;
  /** 同 code 静默窗（ms），缺省 10 分钟 */
  readonly windowMs?: number;
}

/**
 * **系统侧客观事件**（##404 待办 3）：`author: system` 的条目由系统自己写，不靠模型自述。
 *
 * 为什么必须有这条通道：journal 已有 `author` 三态契约，但历史里**全是 `agent`** ——
 * 「落地了 X」「发现了 Y」都是模型自己说的，可能错。客观事实（轮末判成 defect）只有系统说得出来，
 * 且它恰是「事后查为什么这一轮挂了」最有用的那一条。
 *
 * 三条纪律：
 *  · **只写 defect**（判据归调用方）：`external-*` 是环境噪音、全局审计（`log/agent-bash.jsonl`）
 *    已逐轮兜底，journal 再来一份就是双写流水 —— 反而把真正的缺陷埋掉。
 *  · **同 code 有静默窗**：缺陷可能连续几十轮复现（同一个 bug 反复触发），几十条同标题
 *    等于把日志变成计数器。窗内只在**上一条**上判（连续重复才算重复，中间插了别的事就该重记）。
 *  · **失败不许影响调用方**：产出日志是副作用，副作用炸掉不该带走主流程（调用方仍需自己兜）。
 */
export function addSystemEvent(
  taskUri: string,
  input: SystemEventInput,
): { added: JournalRow | null; skipped: "duplicate" | null } {
  requireTask(taskUri);
  const windowMs = input.windowMs ?? 10 * 60 * 1000;
  const tag = `[${input.code}] `;
  const rows = readJournal(taskUri).rows;
  const prev = rows[rows.length - 1];
  if (prev !== undefined && prev.author?.role === "system" && prev.title.startsWith(tag)) {
    const dt = Date.now() - Date.parse(prev.ts);
    if (Number.isFinite(dt) && dt >= 0 && dt < windowMs) return { added: null, skipped: "duplicate" };
  }
  const r = addEntries(taskUri, [
    {
      kind: input.kind ?? "pitfall",
      title: `${tag}${input.title}`,
      ...(input.body === undefined || input.body === "" ? {} : { body: input.body }),
      author: { role: "system" },
    },
  ]);
  return { added: r.added[0] ?? null, skipped: null };
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

/** 锚点渲染成一行短标签（人读 / CLI 打印用；不做 fuzzy 校正，那是装配侧的事） */
function anchorLabel(anchor: Anchor): string {
  const d = anchor.data;
  switch (anchor.type) {
    case "node":
      return `node:${(d as { nodeId: string }).nodeId}`;
    case "message":
      return `message:${(d as { messageId: string }).messageId}`;
    case "task-field":
      return `task-field:${(d as { field: string }).field}`;
    case "doc-range": {
      const r = d as { revisionId: string; offset: number; quote: string };
      const quote = r.quote.length > 40 ? `${r.quote.slice(0, 40)}…` : r.quote;
      return `doc-range:${r.revisionId}@${r.offset} 「${quote}」`;
    }
  }
}

export function renderRow(row: JournalRow): string {
  const when = row.ts.replace("T", " ").slice(0, 16);
  const head = `### #${row.seq} · ${when} · ${row.kind} · ${row.title}`;
  const parts = [head];
  // author 紧跟在标题后：它是「这条能不能当证据」的第一判据，比正文更该先看到
  const meta: string[] = [];
  if (row.author !== undefined) {
    meta.push(`author: \`${row.author.name === undefined ? row.author.role : `${row.author.role}:${row.author.name}`}\``);
  }
  if (row.anchor !== undefined) meta.push(`anchor: \`${anchorLabel(row.anchor)}\``);
  if (meta.length > 0) parts.push(meta.join(" · "));
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

/**
 * 日志文件**原文**（UI 展示「原 JSONL」用）。
 *
 * 为什么不复用 `findJournal`：那个会解析成行、丢掉坏行、重排成 markdown ——
 * 而"原 JSONL"的用途恰恰相反：看得见真实落盘形态，包括**坏行**（半截写入是
 * 这套存储最该暴露的故障）。所以这里只读字节、只数行，不解释。
 */
export function rawJournal(taskUri: string) {
  const file = journalFile(taskUri);
  if (!existsSync(file)) {
    return { task: taskUri, path: file, exists: false, text: "", count: 0, bytes: 0 };
  }
  const text = readFileSync(file, "utf8");
  const count = text.split("\n").filter((l) => l.trim() !== "").length;
  return { task: taskUri, path: file, exists: true, text, count, bytes: Buffer.byteLength(text, "utf8") };
}
