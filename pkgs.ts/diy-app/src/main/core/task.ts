// src/main/core/task.ts
// 🎯 任务 CRUD + 校验。纯函数，无全局状态。
//    任务按项目聚合存放：$DIY_HOME/projects/<pid>/tasks/<tid>/AGENTS.md
//    所有输入验证用 zod，收集全部错误再抛出（不短路）。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { z } from "zod";
import {
  diyHome,
  getTask,
  splitTaskFile,
  taskDir,
  taskFilePath,
  projectsRoot,
  projectDir,
  nextNumericId,
  projectFromUri,
} from "./state";
import type { TaskMeta } from "./state";
import { projectExists } from "./project";
// agent 人物：不传 = **跟随缺省**（不写键），传值则校验存在后固定绑定（人物定义见 core/persona.ts）
import { personaById } from "./persona";
import { isPersonaFollow } from "../../shared/persona";
import { writeFileAtomic } from "./atomic-write";

// ═══════════════════════════════════════
// 字段验证 schema
// ═══════════════════════════════════════

// TaskStateSchema 单一真相源在 task-state.ts（此处 re-export 保持兼容） */
export { TaskStateSchema } from "./task-state";
import { TaskStateSchema } from "./task-state";
// 结构化字段单一真相源在 task-fields.ts（硬编码临时方案，见该文件注释）
import { ChangeTypeSchema, PrioritySchema, MODULE_MAX_LENGTH } from "./task-fields";

// ═══════════════════════════════════════
// 错误类型
// ═══════════════════════════════════════

export interface FieldError {
  readonly field: string;
  readonly code: string;
  readonly msg: string;
}

export class ValidationError extends Error {
  override readonly name = "ValidationError" as const;

  constructor(readonly errors: readonly FieldError[]) {
    super(errors.map((e) => e.msg).join("; "));
  }
}

const FM_SEP = "---";

/** 任务头的**已知键**。用途只有一个：识别「调用方传进来的 body 其实是整份文件」时，
 *  至少要命中一个已知键才算头 —— 否则正文里以 `---` 开头的一段（markdown 分隔线 / 表格）
 *  会被误判成 frontmatter，静默吃掉正文开头。 */
const KNOWN_HEAD_KEYS = new Set([
  "title",
  "state",
  "parent",
  "created",
  "updated",
  "persona",
  "change_type",
  "module",
  "priority",
  "source_type",
  "source_uri",
]);

/** 头的**特征键**（真任务头几乎必有：createTask 必写 state / created，任何一次编辑刷 updated），
 *  而普通文档的 front matter 极少有。用途只有一个：`--append-body` 的**严判据**（见 stripHeadFromBody）。
 *  为什么追加要更严（##322 review R1）：两条路的误判代价**不对称** —— `--body` 收到整份任务文件是常态
 *  （剥头是正解），`--append-body` 收到一份**文档**是常态（Markdown 文档带 front matter 很常见），
 *  同一宽判据在后者会把用户的文档标题（`title:` 恰是已知键）静默吞掉。 */
const STRICT_HEAD_KEYS = ["state", "created", "updated"] as const;

/** 是否 yaml 解析出来的普通对象（数组 / 标量都算"不是头"） */
function isPlainMap(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 组成任务文件文本：头 + 正文。**唯一写入口**（create / edit / append 共用）。
 *
 * 为什么收敛成一处：两处各拼一遍必然分叉 —— 曾经的实测是 create 不补结尾换行、edit 补，
 * 于是「读到的正文写回去」在新建文件上多出一个 \n，往返不 byte-exact（##322）。
 *
 * 正文规范化 = trim：读侧 splitTaskFile 本来就 trim，写侧跟着同一口径，往返才是不动点。
 */
export function composeTaskFile(front: object, body: string): string {
  // lineWidth:-1 禁止折叠长行 → 多行 frontmatter 字段稳定输出 |- 字面块（默认 80 会退化 >-
  // 折叠，空行翻倍、长句被拆行，非 js-yaml 的解析器/人读原文都易误读）
  const frontStr = yaml.dump(front, { indent: 2, noRefs: true, lineWidth: -1 });
  const text = body.trim();
  return `${FM_SEP}\n${frontStr}${FM_SEP}\n${text ? text + "\n" : ""}`;
}

/** 剥出来的头：解析结果 + **原文** + 头之后的正文。
 *  为什么要原文（##322 review R1c）：只回报键名，调用方看不出"到底丢了什么内容" ——
 *  而剥头的本意是"识别到你传的是整份文件"，不是"允许静默吃内容"。 */
export interface StrippedHead {
  head: Record<string, unknown>;
  /** 头原文（`---\n…---\n`，yaml 规范化重排）—— 供调用方核对内容 */
  head_text: string;
  body: string;
}

/**
 * 入参 body 是否其实是「整份任务文件」（frontmatter + 正文）：是则把头剥掉，只返回正文。
 *
 * 为什么（##322 的根因之一）：`--body "$(cat AGENTS.md)"` 是最自然的写法，而写侧此前
 * 把整份当正文收下 → 头被复制进正文 → 双头污染，且异常自我延续（第二段头又成了正文的一部分）。
 * 历史中招：##87/##209/##224/##171/##263/##307/##293/##310/##312。
 *
 * 判据（宁可漏判不可误判）：① 以 `---` 开头；② 头能解析成普通对象；③ 至少命中一个已知任务头键。
 * 任一不满足 → 交回原文（正文里以 `---` 开头是合法 markdown）。
 *
 * `strict`（`--append-body` 用）：在 ③ 之上再要求命中**头的特征键**（state/created/updated）。
 * 追加场景下"传一份文档"是常态，而文档的 front matter 常有 `title:` —— 只认已知键会把文档头吞掉。
 */
export function stripHeadFromBody(raw: string, opts?: { strict?: boolean }): StrippedHead | null {
  if (!raw.startsWith(FM_SEP)) return null;
  let split: { front: Record<string, unknown>; body: string } | null;
  try {
    split = splitTaskFile(raw);
  } catch {
    return null; // `---` 之间不是合法 YAML → 是正文，不是头（别把异常当判据）
  }
  if (!split || !isPlainMap(split.front)) return null;
  const keys = Object.keys(split.front);
  if (keys.length === 0 || !keys.some((k) => KNOWN_HEAD_KEYS.has(k))) return null;
  if (opts?.strict && !STRICT_HEAD_KEYS.some((k) => keys.includes(k))) return null;
  // head_text 走 composeTaskFile（同一写路径的规范化）—— 与真正写盘的头是同一份重排结果
  return { head: split.front, head_text: composeTaskFile(split.front, ""), body: split.body };
}

/** 两组头的差异键（含只在一侧出现的键）—— 只回报，不写回：文件头是权威，入参头只作参考。 */
function headDiffKeys(incoming: Record<string, unknown>, current: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(incoming), ...Object.keys(current)]);
  const out: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(incoming[k]) !== JSON.stringify(current[k])) out.push(k);
  }
  return out.sort();
}

/** 收集某 project 下现有 task 的数字 id（scan $DIY_HOME/projects/<pid>/tasks/） */
function existingTaskIds(projectId: string): string[] {
  const tasksDir = join(projectDir(projectId), "tasks");
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir).filter((e) => /^\d+$/.test(e));
}

// ═══════════════════════════════════════
// 创建任务
// ═══════════════════════════════════════

export interface CreateTaskParams {
  title: string;
  /** 所属 project id */
  project: string;
  parent?: string;
  body?: string;
  source_type?: string;
  source_uri?: string;
  /** agent 人物 **id**；不传 = 当前缺省人物（创建时物化，之后改缺省不影响已有任务） */
  persona?: string;
  /** 变更性质（change_type），见 task-fields.ts */
  change_type?: string;
  /** 模块（`/` 分层自由字符串） */
  module?: string;
  /** 优先级 P0-P3；不传 = 未定级 */
  priority?: string;
}

const CreateTaskSchema = z.object({
  title: z.string().min(1, "标题不能为空").max(200, "标题不超过 200 字符"),
  project: z.string().min(1, "project 不能为空"),
  parent: z.string().optional(),
  body: z.string().optional(),
  source_type: z.string().optional(),
  source_uri: z.string().optional(),
  // 传值 = 固定绑定到该人物；不传（或传 default/空串）= **跟随缺省**（新建默认）
  persona: z.string().optional(),
  change_type: ChangeTypeSchema.optional(),
  module: z.string().trim().max(MODULE_MAX_LENGTH).optional(),
  priority: PrioritySchema.optional(),
});

/**
 * 创建一条任务，写入 projects/<pid>/tasks/<tid>/AGENTS.md。
 * 抛出 ValidationError（校验失败）或 Error（业务冲突）。
 */
export function createTask(params: CreateTaskParams): string {
  const parsed = CreateTaskSchema.safeParse(params);
  if (!parsed.success) {
    const errors: FieldError[] = parsed.error.issues.map((iss) => ({
      field: iss.path.join("."),
      code: iss.code,
      msg: iss.message,
    }));
    throw new ValidationError(errors);
  }

  const { title, project, parent, body, source_type, source_uri, persona, change_type, module, priority } = parsed.data;

  // 校验 project 是否注册（按项目数据目录）
  if (!projectExists(project)) {
    throw new ValidationError([
      { field: "project", code: "not_found", msg: `project ${project} 未注册` },
    ]);
  }

  // 校验父任务存在
  // agent 人物：**不传 = 跟随缺省**（不写 persona 键），显式指定则校验存在后固定绑定。
  //
  // 为什么新建默认"跟随缺省"而不是"物化当时的缺省 id"：用户说"新建任务没选人物"时，
  // 心里想的就是"用我的缺省人物"，而不是"此刻拷一份当时的缺省配置"。物化会让
  // 「后来把缺省改成 B」这件事对老任务完全不可见 —— 用户以为改了缺省全场生效，实际只有新任务生效。
  // 跟随是**引用**而非快照：改缺省，跟随者下一轮一起变（与「改人物影响所有引用者」同一套心智）。
  // 「这一刻到底用了哪个模型」由事件流每 step 记录（见 ##164），不靠 frontmatter 快照保证可观测。
  let personaId: string | undefined;
  if (persona !== undefined && !isPersonaFollow(persona)) {
    if (!personaById(diyHome(), persona)) {
      throw new ValidationError([
        { field: "persona", code: "not_found", msg: `人物 ${persona} 不存在（可用 diy agent persona list 查看 id）` },
      ]);
    }
    personaId = persona;
  }

  if (parent && !getTask(parent)) {
    throw new ValidationError([
      { field: "parent", code: "not_found", msg: `parent ${parent} 不存在` },
    ]);
  }

  // 生成 URI：数字自增 id（scan projects/<pid>/tasks/）
  const tid = nextNumericId(existingTaskIds(project));
  const uri = `projects/${project}/tasks/${tid}`;

  const dir = taskDir(uri);
  mkdirSync(dir, { recursive: true });

  const now = new Date().toISOString();
  const meta: TaskMeta = {
    title,
    state: "pending",
    parent,
    created: now,
    updated: now,
    source_type,
    source_uri,
    // 人物 id：**不写键 = 跟随缺省**（新建的默认）。与 priority 同一套「缺省 = 字段不存在」约定，
    // 免得文件里堆一票 `persona: ''` 噪音
    persona: personaId,
    // 结构化字段：未传则不写键（yaml.dump 跳过 undefined）——「缺省 = 未定级」靠的是
    // 字段不存在，而不是写一个空值，免得文件里堆一票 `priority: ''` 的噪音
    change_type,
    module: module || undefined, // 空白串不落键，避免 `module: ''` 噪音
    priority,
    // 不写 project frontmatter —— project 由 URI 路径推导（路径即分组）
  };

  // 原子写（##382）：低磁盘 / 写入失败时**原文件逐字不变**，绝不把正文清成 0 字节。
  writeFileAtomic(taskFilePath(uri), composeTaskFile(meta, body ?? ""));

  return uri;
}

// ═══════════════════════════════════════
// 更新任务
// ═══════════════════════════════════════

export interface UpdateTaskChanges {
  title?: string;
  state?: string;
  body?: string;
  /**
   * **追加**正文（不覆盖）：`--append-body <file|->` 的落地。
   *
   * 为什么需要它（##322 的最硬根因）：`--body` 是整篇覆盖 → 任何"追加一段"都得先取磁盘真值
   * 再拼回 → 逼出 read-modify-write，而 read-modify-write 正是双头污染与"白读一遍文件"的来源。
   * 有了追加原语，agent 不必先读任务文件就能把内容写进去。
   */
  appendBody?: string;
  parent?: string;
  /**
   * 人物 id：三态 —— 不传=保持 / `""`（或 `default`）=**跟随缺省**（删掉该键）/ 值=固定绑定到该人物。
   * 空值不再是"非法"，而是"取消固定绑定"这一合法动作（新建任务的默认状态）。
   */
  persona?: string;
  /** 空字符串 = 清除该字段（与 parent 的三态一致：不传=保持 / ""=清除 / 值=设置） */
  change_type?: string;
  module?: string;
  priority?: string;
}

/** 正文最小长度。空值/误传（`--body ""`）会静默清空整篇正文且不可恢复（见任务 138），
 *  故低于此长度一律拒绝 —— 宁可让调用方显式确认，也不让一次手滑毁掉内容。 */
export const MIN_BODY_LENGTH = 10;

/**
 * 正文输入的**显式三态**（##338）：
 *   整篇覆盖 `body` / `bodyText` / `bodyFile`，追加 `appendBody` / `appendBodyFile` / `appendBodyText`。
 *   每组**三选一**（同时给多个 → 报错，不猜、也不按顺序取）。
 *
 * 为什么要把"传文本"和"传文件"拆成不同的键：CLI 上 `--body` 只收文本，而 `--append-body` 收 `<file|->`
 * —— 两侧不对称，而直觉上"都是传文件"，于是 `diy task edit X --body /tmp/x.md` 把**路径串当正文静默存下**、
 * 原正文丢失且无告警（##290 / ##294 / ##87 三例现场）。拆键让语义显式；「形如单行路径即拒」的护栏
 * 只挂在旧的 `body` 上（`bodyText` 是它的逃逸口：正文本身就是一行路径时用它），
 * 护栏实现在 CLI 解析期（`pkgs.ts/diy-rpc/src/cli/_parser.ts::pathLikeValue` —— cwd 是调用方的，判得准）。
 *
 * 注：`bodyFile` / `appendBodyFile` 到这里已经是**文件内容**（读取发生在调用方进程的 parser，
 * 见 `_CliOptionMeta.readFile`）；本函数只做"哪个键被给了"的裁决。
 */
export interface BodyInputs {
  body?: string;
  bodyText?: string;
  bodyFile?: string;
  appendBody?: string;
  appendBodyFile?: string;
  appendBodyText?: string;
}

/** 一组「三选一」的取值：恰好一个 → 取它；多个 → ValidationError；零个 → undefined（未指定=保持原值）。 */
function pickOneOf(group: BodyInputs, field: string, keys: readonly (keyof BodyInputs)[]): string | undefined {
  const given = keys.filter((k) => group[k] !== undefined);
  if (given.length === 0) return undefined;
  if (given.length === 1) return group[given[0]!];
  throw new ValidationError([
    { field, code: "conflict", msg: `${keys.join(" / ")} 三选一（同时给了 ${given.join(" 与 ")}）` },
  ]);
}

/**
 * 整篇覆盖那一组的「三选一」裁决（`body` / `bodyText` / `bodyFile`）—— **唯一裁决点**。
 *
 * 为什么单独导出（##376）：`task edit` / `task create` / `task drafts set` 三个命令都收"内联正文"，
 * 护栏（`inlineText`）与逃生口（`--body-text` / `--body-file`）必须同源 —— 各写一遍必然分叉，
 * 分叉的表现就是"某条命令漏了护栏"（##376 的来由正是 edit 挂了、create / drafts set 没挂）。
 */
export function resolveBodyOverride(input: BodyInputs): string | undefined {
  return pickOneOf(input, "body", ["body", "bodyText", "bodyFile"]);
}

/** 把 `BodyInputs` 求值成 `UpdateTaskChanges` 的 `body` / `appendBody`（唯一裁决点）。 */
export function resolveBodyInputs(input: BodyInputs): { body?: string; appendBody?: string } {
  return {
    body: resolveBodyOverride(input),
    appendBody: pickOneOf(input, "append_body", ["appendBody", "appendBodyFile", "appendBodyText"]),
  };
}

const UpdateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  state: TaskStateSchema.optional(),
  // 校验只看 trim 后的长度（判「够不够长」），写入侧同样 trim（composeTaskFile）——
  // 读侧 splitTaskFile 也 trim，故「读到的正文写回去」是不动点（往返 byte-exact，##322）。
  body: z
    .string()
    .optional()
    .refine((v) => v === undefined || v.trim().length >= MIN_BODY_LENGTH, {
      message: `正文至少 ${MIN_BODY_LENGTH} 个字符（拒绝空/过短输入，避免误清空正文）`,
    }),
  parent: z.string().optional(),
  // 空串（或 `default`）= 跟随缺省：先过校验，再在下面翻译成"删键"。
  // 若写成 .min(1)，取消固定绑定这个合法动作会被 schema 拦成 ValidationError。
  persona: z.string().optional(),
  // `.or(z.literal(""))`：空串是「清除」这一合法语义，要先过校验再在下面翻译成删键。
  // 若只写 .optional()，清除动作会被 schema 拦成 ValidationError。
  change_type: ChangeTypeSchema.or(z.literal("")).optional(),
  module: z.string().trim().max(MODULE_MAX_LENGTH).or(z.literal("")).optional(),
  priority: PrioritySchema.or(z.literal("")).optional(),
});

/** 剥头回报：剥了哪些键 + **被剥掉的原文**（只报键名，调用方看不出丢了什么内容）。 */
export interface StrippedHeadReport {
  keys: string[];
  /** 剥掉的头原文（`---\n…---\n`，yaml 规范化重排） */
  head_text: string;
  /** 与文件现有头**不一致**的键（仅 `--body`：文件头为准，未写回；列出来是让调用方知道有东西被忽略了） */
  differs?: string[];
}

/** 写侧回报：剥离/追加做了什么（**不静默改用户内容**——改了/识别了什么都要说）。 */
export interface TaskWriteReport {
  /** 入参 `--body` 其实是「整份文件」→ 头已剥离（取正文） */
  body_head_stripped?: StrippedHeadReport;
  /** 入参 `--append-body` 其实是「整份文件」→ 头已剥离（取正文） */
  append_head_stripped?: StrippedHeadReport;
  /** 追加模式实际追加的字符数 */
  appended_chars?: number;
}

/** 更新任务指定字段。返回本次写入实际做了什么（剥离 / 追加），供调用方回报用户。 */
export function updateTask(uri: string, changes: UpdateTaskChanges): TaskWriteReport {
  const existing = getTask(uri);
  if (!existing) throw new Error(`任务 ${uri} 不存在`);

  // ── 写侧对称（##322）：`--body` / `--append-body` 收到整份文件（头 + 正文）时先剥头，只用正文 ──
  // 校验必须在**剥离之后**：否则传整份文件时空正文会被当成"够长"，一次手滑清空正文。
  //
  // 两条路的判据**不对称**（##322 review R1）：`--body` 收到整份任务文件是常态（剥头是正解）；
  // `--append-body` 收到一份**文档**是常态（Markdown 文档带 front matter 很常见，`title:` 恰是已知键）
  // ⇒ 追加用严判据，否则用户的文档标题被静默吞掉（同一判据下误判代价不对称）。
  const stripped = changes.body !== undefined ? stripHeadFromBody(changes.body) : null;
  const appendStripped = changes.appendBody !== undefined ? stripHeadFromBody(changes.appendBody, { strict: true }) : null;
  const effective = {
    ...changes,
    ...(stripped ? { body: stripped.body } : {}),
    ...(appendStripped ? { appendBody: appendStripped.body } : {}),
  };

  // 追加内容为空：早报（还没动任何东西）——"追加了个空段落"比报错更难查
  const appendedText = effective.appendBody?.trim() ?? null;
  if (appendedText !== null && appendedText === "") {
    throw new ValidationError([
      { field: "append_body", code: "too_small", msg: "追加内容为空（没有可追加的正文）" },
    ]);
  }

  const parsed = UpdateTaskSchema.safeParse(effective);
  if (!parsed.success) {
    const errors: FieldError[] = parsed.error.issues.map((iss) => ({
      field: iss.path.join("."),
      code: iss.code,
      msg: iss.message,
    }));
    throw new ValidationError(errors);
  }

  const now = new Date().toISOString();
  /**
   * 三态字段求值：`undefined` 未指定→保持原值 / `""` 清除→undefined / 有值→用新值。
   * 与 parent 的语义对齐，让所有可清除字段共用一套规则。
   */
  const triState = <T>(next: string | undefined, parsedValue: T | undefined, existing: T | undefined): T | undefined => {
    if (next === undefined) return existing;
    // 空白串按清除处理：否则 `--module "  "` 会写下一个空值键，与「缺省=未设置」不一致
    if (next.trim() === "") return undefined;
    return parsedValue;
  };
  // 父字段三态：显式取消(空串→undefined 父)、设新父、未指定(undefined→保持)
  let newParent: string | undefined;
  if (changes.parent === "") {
    newParent = undefined; // 显式取消父子关系
  } else if (changes.parent !== undefined) {
    newParent = parsed.data.parent;
  }
  if (changes.parent !== undefined) {
    // 唯一守卫点：父任务存在 + 同项目 + 防环（不能挂到自己子孙下，否则父子成环）
    const parentProj = newParent ? projectFromUri(newParent) : "";
    const uriProj = projectFromUri(uri);
    if (newParent && uriProj && parentProj && uriProj !== parentProj) {
      throw new Error(`只能在同一项目内设置父子关系 (${uriProj} ≠ ${parentProj})`);
    }
    if (newParent && !getTask(newParent)) throw new Error(`父任务 ${newParent} 不存在`);
    if (newParent) {
      let cur = newParent;
      const seen = new Set<string>();
      while (cur) {
        if (seen.has(cur)) break; // 防御既有环
        seen.add(cur);
        if (cur === uri) throw new Error("不能设置自己的子任务为父级（会形成循环）");
        const t = getTask(cur);
        cur = t?.parent ?? "";
      }
    }
  }
  // ── 写回：在**原 frontmatter** 上就地覆盖，而不是按白名单字段重建 ──
  //
  // 重建（`{title, state, parent, created, updated}` 再整份 dump）会把认不出的键
  // 整批丢掉：用户手工加的自定义字段（tags / note / 任意自造键…）、以及 source_type /
  // source_uri 这类非本函数管理的字段，都会在任何一次编辑（哪怕只改 state）时静默
  // 消失 —— 它们不归我们管，无权删除。故改为「读原始 frontmatter → 只覆盖我们负责
  // 的键 → 其余原样写回」。
  //
  // 注意：不再从 existing 写回 project。那条路径会把 URI 派生值固化进文件，
  // 让「本没有该字段」的任务凭空多出一个 project。
  const fp = taskFilePath(uri);
  const split = splitTaskFile(readFileSync(fp, "utf-8"));
  if (!split) throw new Error(`任务文件格式非法（缺少 frontmatter）: ${fp}`);
  const front: Record<string, unknown> = { ...split.front };

  /** undefined = 不写该键（键不存在则保持不存在），与我们「无权新增/删除用户字段」的原则一致 */
  const setOrClear = (key: string, value: unknown): void => {
    if (value === undefined) delete front[key];
    else front[key] = value;
  };
  setOrClear("title", parsed.data.title ?? existing.title);
  setOrClear("state", parsed.data.state ?? existing.state);
  // 注：detail 字段已下线（任务模型只有 title + 内容）。此处不主动删除它 —— 字段下线走显式
  // 迁移（scripts/），例行编辑不动非托管键，见本函数上方注释。
  // 未指定 parent 保持原值；指定了（含空串取消）用 newParent 结果
  setOrClear("parent", changes.parent === undefined ? existing.parent : newParent);
  setOrClear("created", existing.created);
  // 人物：三态（未指定 = 保持原绑定）
  if (changes.persona !== undefined) {
    if (isPersonaFollow(changes.persona)) {
      // 跟随缺省 = 删键（与 priority/change_type 的"缺省 = 不写键"同构）。
      // 必须在 setOrClear 之前 model 化：下面 setOrClear 会按需删掉空值键
      delete front["persona"];
    } else {
      if (!personaById(diyHome(), changes.persona)) {
        throw new ValidationError([
          { field: "persona", code: "not_found", msg: `人物 ${changes.persona} 不存在（可用 diy agent persona list 查看 id）` },
        ]);
      }
      front["persona"] = changes.persona;
    }
  }
  setOrClear("change_type", triState(changes.change_type, parsed.data.change_type, existing.change_type));
  setOrClear("module", triState(changes.module, parsed.data.module, existing.module));
  setOrClear("priority", triState(changes.priority, parsed.data.priority, existing.priority));
  front["updated"] = now;

  // ── 追加原语：正文 = 现有正文 + 空行 + 追加内容（append 永不缩短正文，故不走最小长度守卫）──
  const appended = appendedText;
  let nextBody = (parsed.data.body ?? split.body).trim();
  if (appended) nextBody = nextBody ? `${nextBody}\n\n${appended}` : appended;

  // 原子写（##382）：追加 / 覆盖正文失败时磁盘上的旧正文**逐字不变**（旧实现先清空再写，
  // 低磁盘下把 253KB 正文写成了 0 字节）。
  writeFileAtomic(fp, composeTaskFile(front, nextBody));

  return {
    // 头被剥掉了：键清单 + 与文件头不一致的键（后者**没有写回** —— 文件头是权威，
    // 入参头若来自陈旧副本，静默采纳等于把旧值/已删字段复活）
    ...(stripped
      ? {
          body_head_stripped: {
            keys: Object.keys(stripped.head).sort(),
            head_text: stripped.head_text,
            differs: headDiffKeys(stripped.head, split.front),
          },
        }
      : {}),
    // 追加剥出的头**不回 differs**：它压根不参与合并（append 只取正文），无从"不一致"
    ...(appendStripped
      ? { append_head_stripped: { keys: Object.keys(appendStripped.head).sort(), head_text: appendStripped.head_text } }
      : {}),
    ...(appended ? { appended_chars: appended.length } : {}),
  };
}

// ═══════════════════════════════════════
// 移动任务（改变父级）
// ═══════════════════════════════════════

/**
 * 移动任务到新父级。与编辑隔离：语义上只改变父子关系，
 * 全部校验（父存在 / 同项目 / 防环）收敛在 updateTask 内。
 * parent 为空字符串 = 取消父子关系（提升为顶级）。
 */
export function moveTask(uri: string, parent: string): void {
  if (!getTask(uri)) throw new Error(`任务 ${uri} 不存在`);
  updateTask(uri, { parent });
}

// ═══════════════════════════════════════
// 删除任务
// ═══════════════════════════════════════

/** 删除任务目录（含 AGENTS.md） */
export function deleteTask(uri: string): void {
  const dir = taskDir(uri);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════
// 列出任务
// ═══════════════════════════════════════

/** 列出所有任务 URI（可选按 project 筛选），返回 projects/<pid>/tasks/<tid>。 */
export function listTasks(project?: string): string[] {
  const root = projectsRoot();
  if (!existsSync(root)) return [];

  const uris: string[] = [];
  for (const pid of readdirSync(root)) {
    if (!/^\d+$/.test(pid)) continue;
    if (project !== undefined && pid !== project) continue;

    const tasksDir = join(projectDir(pid), "tasks");
    if (!existsSync(tasksDir)) continue;

    for (const tid of readdirSync(tasksDir)) {
      if (!/^\d+$/.test(tid)) continue;
      if (existsSync(join(tasksDir, tid, "AGENTS.md"))) {
        uris.push(`projects/${pid}/tasks/${tid}`);
      }
    }
  }
  return uris;
}