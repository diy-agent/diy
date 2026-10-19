// src/main/core/flow-store.ts — 工作流实例的**落盘层**（文件布局 + 读写 + 对账）
//
// ##319 口径（owner 计划 §2）：任务目录下 `flow/` 四份文件，**双写、单一权威**
//   instance.json  绑定：`{ workflowId, params, ref? }`（**不动任务 frontmatter、不进 state.yaml**）
//   state.json     **整份快照 = 唯一权威真源**（由内核 `flowStateToJson` 写、`flowStateFromJson` 读）
//   path.jsonl     append-only 增量（每次**领域操作**一行）—— **重建材料，不是第二真源**
//   events.jsonl   审计事件流（宿主渲染的正文 + 结构化语义）—— **可清可丢，删了不影响运行**
//
// 权威口径（写在这里，读代码的人不用猜）：
//   · **读只读 state.json**。`instance.json` 只提供「哪个工作流 / 哪份关联」；它的 `params` 是
//     绑定期的回显，**不拿去跑**（跑用 state.json 那份 —— 那才是内核认的领域事实）。
//   · `path.jsonl` 只用于**重建 / 审计**：从 `initialState()` 起把每条记录喂回内核（`config` → 参数值、
//     `advance` → 位置变更、`finish` → `done` 置位）
//     （重建走的是**内核自己的正路**，不是本文件另写一套折叠），产物必须与快照**逐字节同形**
//     （规范化后比较，见 `assertSnapshotMatches`）。不一致 ⇒ **亮错**，绝不静默择一。
//   · `events.jsonl` 与 `$DIY_HOME/log/` 同定性：删掉、损坏都不影响运行（读侧容错 + 报计数）。
//     `path.jsonl` 不能这么办 —— 它参与对账，坏行即「重建不出快照」⇒ 必须亮错。
//
// 为什么状态不进 `state.yaml`：那是**运行中的应用独占写入**的核心状态（`data.state` 约定），
// 外部写它 = 与运行中的 app 抢同一份文件。任务目录下的 `flow/` 才是实例自己的地盘。
// 为什么是 `flow/` 而不是 `.diy/`：owner 计划 §2 明确指定（任务的系统自留地 `.diy/` 另有一套
// 归属约定，见 core/state.ts 的 taskSystemDir）。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic-write";
import {
    FlowError,
    advance,
    flowStateFromJson,
    flowStateToJson,
    initialState,
    parseFlowState,
    type AdvanceRequest,
    type FlowState,
    type WorkflowDef,
} from "@diy/flow";
import { taskDir } from "./state";

/** 实例绑定（`instance.json` 的形状）。`params` 是绑定期的**生效全量值**回显（权威仍是 state.json）。 */
export interface FlowBinding {
    readonly workflowId: string;
    readonly params: Readonly<Record<string, unknown>>;
    /** 宿主关联标识（内核 `Visit.ref` 的同一个开放袋；本任务固定给 `taskUri`） */
    readonly ref?: Readonly<Record<string, string>>;
}

/** 一条审计记录（`events.jsonl` 的一行）——移词语义由内核给，正文由宿主渲染（内核不编人类文本） */
export interface FlowAuditRecord {
    readonly id: string;
    readonly at: string;
    /** `start` = 建实例（不是位置变更，故不进 path.jsonl） */
    readonly kind: "start" | "entry" | "next" | "bounce" | "params" | "finish";
    readonly from: string | null;
    readonly to: string | null;
    readonly author: string;
    readonly content: string;
    readonly ref?: Readonly<Record<string, string>>;
}

/** 文件的路径（唯一出口；别处不许自己 join）—— 四份领域/审计文件 + 讨论流（旁注，见 `FlowPost`）。 */
export function flowDir(uri: string): string {
    return join(taskDir(uri), "flow");
}

export function flowFile(uri: string, name: "instance" | "state" | "path" | "events" | "threads"): string {
    const file = name === "path"
        ? "path.jsonl"
        : name === "events"
            ? "events.jsonl"
            : name === "threads"
                ? "threads.jsonl"
                : `${name}.json`;
    return join(flowDir(uri), file);
}

/**
 * 产物袋（##337）—— 任务目录 `flow/artifacts/<节点 id>.json`，与上面四份**并列**（第五份）。
 *
 * 定性（与四份的分别）：**产物不是领域态**（`rule.domain-first`：领域态只有 `position`/`path`/`params`/`done`）
 * —— 不进 `state.json`、不参与 `path.jsonl` 对账、**删了不影响推进**；推进也不产生它：本版的真来源是
 * 「人 / 后续任务把 raw 放进来」（agent 产出是后续任务）。它是**派生数据**：raw → render 插件 → view。
 *
 * 形状：**JSON 数组，下标 = 该节点第 n 次驻留（`Visit.seq`）− 1**；`null` 或越界 = 该驻留无产物。
 */
export function artifactDir(uri: string): string {
    return join(flowDir(uri), "artifacts");
}

export function artifactFile(uri: string, nodeId: string): string {
    // 节点 id 直接当文件名 ⇒ 这里兜一道「不许含路径分隔符 / 不许是 . 或 ..」。
    // 调用方（core/flow.ts）另有一道「节点必须在本工作流定义里」的闸门 —— **两道都要**：
    // id 来自定义，而定义是宿主 / 工作流开发包给的，不能假定它一定干净。
    if (nodeId === "" || nodeId === "." || nodeId === ".." || nodeId.includes("/") || nodeId.includes("\\")) {
        throw new Error(`节点 id 不能用作产物袋文件名：${JSON.stringify(nodeId)}`);
    }
    return join(artifactDir(uri), `${nodeId}.json`);
}

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, "utf-8"));
}

/** 读绑定；文件缺失 / 结构不符 → null（「没建实例」与「实例坏了」由调用方区分：后者 JSON 解析会抛） */
export function readBinding(uri: string): FlowBinding | null {
    const path = flowFile(uri, "instance");
    if (!existsSync(path)) return null;
    const raw = readJson(path);
    if (typeof raw !== "object" || raw === null) throw new Error(`实例绑定不是对象：${path}`);
    const obj = raw as Record<string, unknown>;
    const workflowId = obj["workflowId"];
    if (typeof workflowId !== "string" || workflowId === "") {
        throw new Error(`实例绑定缺少 workflowId：${path}`);
    }
    const params = obj["params"];
    if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
        throw new Error(`实例绑定的 params 应为对象：${path}`);
    }
    const binding: { workflowId: string; params: Record<string, unknown>; ref?: Record<string, string> } = {
        workflowId,
        params: (params as Record<string, unknown>) ?? {},
    };
    const ref = obj["ref"];
    if (ref !== undefined) {
        if (typeof ref !== "object" || ref === null || Array.isArray(ref)) throw new Error(`实例绑定的 ref 应为对象：${path}`);
        for (const [k, v] of Object.entries(ref)) {
            if (typeof v !== "string") throw new Error(`实例绑定的 ref.${k} 应为字符串：${path}`);
        }
        binding.ref = ref as Record<string, string>;
    }
    return binding;
}

export function writeBinding(uri: string, binding: FlowBinding): void {
    // 键序固定（diff 友好、与内核 `flowStateToJson` 同一立场）：workflowId → params → ref
    const out: Record<string, unknown> = { workflowId: binding.workflowId, params: binding.params };
    if (binding.ref !== undefined) out["ref"] = binding.ref;
    writeFileAtomic(flowFile(uri, "instance"), `${JSON.stringify(out, null, 2)}\n`);
}

/** 读快照（**唯一权威真源**）。缺失 → null；非法快照一律抛（内核 `parseFlowState` 不降级） */
export function readState(uri: string): FlowState<string> | null {
    const file = flowFile(uri, "state");
    if (!existsSync(file)) return null;
    return flowStateFromJson<string>(readFileSync(file, "utf-8"));
}

/** 写快照（先经内核规范化 ⇒ 键序固定、字段封闭，落盘即稳定文本） */
export function writeState(uri: string, state: FlowState<string>): void {
    writeFileAtomic(flowFile(uri, "state"), `${flowStateToJson(state)}\n`);
}

/**
 * 增量记录（`path.jsonl` 的一行）—— **改写领域态的领域操作**。
 *
 * 三种操作（`FlowState` 的三部分各有一种来源，缺一即「重建不出快照」）：
 *   · `config` —— 定/改本次运行的 L2 参数值（`start` 与「尚未进入时的 `params set`」）。
 *     **必须有它**：`FlowState.params` 是领域态的一部分，而位置变更（`advance`）**不产生**参数值
 *     —— 不记 config，尚未进入的实例就永远对不上账（首版实测：start 后立刻 show 即亮错）。
 *   · `finish` —— **收尾**（`FlowState.done` 置位，`diy flow finish`）：`done` 同样不是位置变更的产物，
 *     不记它就重建不出快照（##319 review1 P2-B：`done` 只由内核 `step` 的终态分支置位，宿主走不到那条路，
 *     故宿主的「宣布收尾」是它的唯一来源，必须自己留重建材料）。
 *   · `advance` —— 一次位置变更（`{ to, at, ref? }`）。
 *
 * 为什么 `advance` 记录里**不写** `params`：参数值有唯一的来源（config 记录），`advance` 只做位置变更
 * （它带的那份 `params` 就是「继承状态那份」，内核据此保证正路状态自足 —— 重建走的是同一个内核，
 * 不需要把同一份值在每行复述一遍）。
 */
export type FlowPathRecord =
    | { readonly op: "config"; readonly params: Readonly<Record<string, unknown>> }
    | { readonly op: "advance"; readonly to: string; readonly at: string; readonly ref?: Readonly<Record<string, string>> }
    /** 收尾（`done` 置位）。`at` 只为审计可读，重建不依赖它（重建只认「有过一次收尾」这个事实） */
    | { readonly op: "finish"; readonly at: string };

export function appendPathRecord(uri: string, record: FlowPathRecord): void {
    const out: Record<string, unknown> = record.op === "config"
        ? { op: "config", params: record.params }
        : record.op === "finish"
            ? { op: "finish", at: record.at }
            : record.ref === undefined
                ? { op: "advance", to: record.to, at: record.at }
                : { op: "advance", to: record.to, at: record.at, ref: record.ref };
    const file = flowFile(uri, "path");
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(out)}\n`, "utf-8");
}

/** 读 `path.jsonl` 的全部记录。坏行 / 坏形状 ⇒ **抛**（它参与对账：读不出即「重建不出快照」，必须亮错） */
export function readPathRecords(uri: string): FlowPathRecord[] {
    const file = flowFile(uri, "path");
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim() !== "");
    return lines.map((line, i) => {
        let raw: unknown;
        try {
            raw = JSON.parse(line);
        } catch (e) {
            throw new Error(
                `path.jsonl 第 ${i + 1} 行不是合法 JSON（它是重建材料，坏了就重建不出快照 —— 需要人工修或重开实例）：${(e as Error).message}`,
            );
        }
        if (typeof raw !== "object" || raw === null) throw new Error(`path.jsonl 第 ${i + 1} 行不是对象`);
        const rec = raw as Record<string, unknown>;
        if (rec["op"] === "config") {
            const params = rec["params"];
            if (typeof params !== "object" || params === null || Array.isArray(params)) {
                throw new Error(`path.jsonl 第 ${i + 1} 行（config）的 params 应为对象`);
            }
            return { op: "config", params: params as Record<string, unknown> };
        }
        if (rec["op"] === "advance") {
            if (typeof rec["to"] !== "string" || typeof rec["at"] !== "string") {
                throw new Error(`path.jsonl 第 ${i + 1} 行（advance）缺少 to / at`);
            }
            const out: { op: "advance"; to: string; at: string; ref?: Readonly<Record<string, string>> } = {
                op: "advance",
                to: rec["to"],
                at: rec["at"],
            };
            if (rec["ref"] !== undefined) out.ref = rec["ref"] as Record<string, string>;
            return out;
        }
        if (rec["op"] === "finish") {
            if (typeof rec["at"] !== "string") throw new Error(`path.jsonl 第 ${i + 1} 行（finish）缺少 at`);
            return { op: "finish", at: rec["at"] };
        }
        throw new Error(`path.jsonl 第 ${i + 1} 行的 op 未知（只认 config / advance / finish）：${JSON.stringify(rec["op"])}`);
    });
}

/** 追加审计事件（可清可丢；审计坏了不该影响运行 —— 读侧见 `readAudit`） */
export function appendAudit(uri: string, record: FlowAuditRecord): void {
    const file = flowFile(uri, "events");
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, "utf-8");
}

/** 读审计事件（**容错**：坏行跳过并计数 —— 审计流坏了不该影响运行，与 path.jsonl 的立场相反） */
export function readAudit(uri: string): { records: FlowAuditRecord[]; skipped: number } {
    const file = flowFile(uri, "events");
    if (!existsSync(file)) return { records: [], skipped: 0 };
    const records: FlowAuditRecord[] = [];
    let skipped = 0;
    for (const line of readFileSync(file, "utf-8").split("\n")) {
        if (line.trim() === "") continue;
        try {
            records.push(JSON.parse(line) as FlowAuditRecord);
        } catch {
            skipped += 1;
        }
    }
    return { records, skipped };
}

// ═══════════════════════════════════════════════════════════════
// 讨论流（##342）：`flow/threads.jsonl` —— 打回意见与讨论的**一等载体**
// ═══════════════════════════════════════════════════════════════
//
// 定性（**旁注 / 审计**，不是领域态）：
//   · 与 `events.jsonl` 并列、同样**可清可丢**：删掉 / 损坏都**不影响推进**（`rule.core-log`）；
//   · **不进 `state.json`**（`rule.domain-first`：领域态只有 position / path / params / done）；
//   · **驱动判据不读它**（打回判据看节点结论末行，不看这里）。
// 为什么还要它：打回反复争论的**意见正文**此前只有 `--note`（审计后缀），没有一等载体 ——
// 讨论要可见、要留痕，就得有自己的流（##342 的用户原话）。
//
// 形状（判别联合：`type` 同级 = 所有分支共有；三分支字段集相同 ⇒ 无私有数据、不设 `data`）：
//   `{ id, at, author, type, anchor:{from,to,seq}, text }`
// **锚点 = 一条真打回边的一次穿越**：`from` = 打回前位置、`to` = 落点节点、
// `seq` = **落点那次驻留**的 `Visit.seq`。一次 bounce 恰好创生一次驻留 ⇒ 该三元组唯一；
// 同节点二次打回各是各的（不同 `seq`）—— 这正是 ##320 P1-1「逐驻留键必须带 seq」的教训。
// 线程的文本 id = `from->to#seq`（人可读、可当 CLI 参数）。

/** 发言的类型：普通发言（含自动打回时的意见正文）/ 宣布线程已解决 / 升级人裁决 */
export type FlowPostType = "note" | "resolved" | "escalate";

/** 线程锚点 = 一条**真打回边的一次穿越**（见上面「形状」；锚点必须真，不造数据） */
export interface FlowAnchor {
    readonly from: string;
    readonly to: string;
    readonly seq: number;
}

/** 一条发言（`threads.jsonl` 的一行） */
export interface FlowPost {
    readonly id: string;
    readonly at: string;
    /** 谁说的：`cli`（人敲） / agent 标识（驱动环起的轮次） / `human` */
    readonly author: string;
    readonly type: FlowPostType;
    readonly anchor: FlowAnchor;
    readonly text: string;
}

/** 线程的文本 id（CLI 参数 / UI 键）：`from->to#seq` */
export function anchorKey(anchor: FlowAnchor): string {
    return `${anchor.from}->${anchor.to}#${anchor.seq}`;
}

/** 反解线程 id —— 形状不对即抛（这是个**输入闸门**，不静默吞掉） */
export function parseAnchorKey(key: string): FlowAnchor {
    const m = /^(.*?)->(.*?)#(\d+)$/.exec(key.trim());
    if (!m || m[1] === "" || m[2] === "") {
        throw new Error(`线程写法应为 <打回源节点>-><落点节点>#<落点驻留序号>，实得 ${JSON.stringify(key)}`);
    }
    return { from: m[1]!, to: m[2]!, seq: Number(m[3]) };
}

const POST_TYPES: readonly FlowPostType[] = ["note", "resolved", "escalate"];

/** 一行的形状校验（读侧容错用：形状不对 ⇒ 跳过并计数，不当成发言） */
function parsePost(raw: unknown): FlowPost | null {
    if (typeof raw !== "object" || raw === null) return null;
    const o = raw as Record<string, unknown>;
    const { id, at, author, type, text } = o;
    if (typeof id !== "string" || typeof at !== "string" || typeof author !== "string" || typeof text !== "string") return null;
    if (typeof type !== "string" || !POST_TYPES.includes(type as FlowPostType)) return null;
    const a = o["anchor"];
    if (typeof a !== "object" || a === null) return null;
    const { from, to, seq } = a as Record<string, unknown>;
    if (typeof from !== "string" || typeof to !== "string" || typeof seq !== "number" || !Number.isInteger(seq)) return null;
    return { id, at, author, type: type as FlowPostType, anchor: { from, to, seq }, text };
}

/**
 * 发言正文的**非空闸门**（##342 review1 P2-1：这是**唯一真源**，两个写入口共用）。
 *
 * 为什么必须收成一处：本任务有两条写入口 —— CLI 面板（`flow-thread.ts::postThread`）与
 * `bounce --opinion` / **驱动环自动打回**（`flow.ts::appendBounceOpinion`）。各装各的闸就会漏，
 * 而实测漏掉的恰是**无人值守的主路径**：`verdictOf("结论：打回")` 合法地给出 `reason: ""`
 * （`pit.flow-driver` ⑤ 允许结论行只写「打回」）⇒ 讨论流里落一条**没有任何内容的争议发言**，
 * 同一回打回在审计（记 `打回`）与讨论流（`""`）两处留痕不一致 —— 而「留痕可见」正是本任务的交付。
 *
 * 拒绝 = 抛；调用方自己决定往上抛（CLI）还是降级成 warning（驱动环：领域事实已落盘，不该因留痕停环）。
 */
export function requirePostText(text: string): void {
    if (text.trim() === "") throw new Error("发言正文为空：不写空发言（要么给正文，要么别发）");
}

/** 追加一条发言（append-only；目录不存在就建） */
export function appendPost(uri: string, post: FlowPost): void {
    const file = flowFile(uri, "threads");
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(post)}\n`, "utf-8");
}

/**
 * 读讨论流（**容错**：坏行跳过并计数 —— 旁注坏了不该影响运行，与 `readAudit` 同一立场，
 * 也与 `path.jsonl` 的「坏了就亮错」相反：那是重建材料，这是旁注）。
 */
export function readPosts(uri: string): { posts: FlowPost[]; skipped: number } {
    const file = flowFile(uri, "threads");
    if (!existsSync(file)) return { posts: [], skipped: 0 };
    const posts: FlowPost[] = [];
    let skipped = 0;
    for (const line of readFileSync(file, "utf-8").split("\n")) {
        if (line.trim() === "") continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            skipped += 1;
            continue;
        }
        const post = parsePost(parsed);
        if (post) posts.push(post);
        else skipped += 1;
    }
    return { posts, skipped };
}

/** 收尾：把领域态标记为**已跑完**（`FlowState.done = true`）。
 *
 * 用的就是内核自己的写法（`execute.ts` 终态分支也是原地加标记 `{ ...state, done: true }`，**不经过
 * `advance`** —— 那不是一次位置变更），再交给内核 `parseFlowState` 兜住不变式（`done ⇒ 已进入`）。
 * 宿主把 `done` 写进状态文件**不需要内核新导出**：它本就是序列化契约里的一等字段。
 *
 * **一处实现**：`finishFlow`（写侧）与 `rebuildState`（重建侧）共用它 —— 两侧各写一遍迟早分叉。
 */
export function applyFinish(state: FlowState<string>): FlowState<string> {
    if (state.position === null) {
        throw new FlowError("invalid-state", "尚未进入工作流（position 为 null）：没跑过就无所谓「走完」", "flow/state.json");
    }
    return parseFlowState<string>({
        position: state.position,
        path: state.path,
        ...(state.params === undefined ? {} : { params: state.params }),
        done: true,
    });
}

/**
 * 按 `path.jsonl` 重建领域态 —— 走内核正路（`advance` + `parseFlowState`），不另写折叠逻辑。
 * config 记录只能在**尚未进入**时出现（内核立场：进入后换配置 = 另起一次运行）—— 违反即亮错。
 * finish 之后不许再有 advance（终端节点无 next 出边 ⇒ 位置变更不可能；有则是手改过日志）—— 同样亮错。
 */
export function rebuildState(def: WorkflowDef<string>, records: readonly FlowPathRecord[]): FlowState<string> {
    let state = initialState<string>();
    for (const record of records) {
        if (record.op === "config") {
            if (state.position !== null) {
                throw new FlowError(
                    "invalid-state",
                    `path.jsonl 里有一条 config 记录出现在进入工作流之后（position = ${state.position}）：` +
                        "进入后换参数值 = 另起一次运行，日志自相矛盾",
                    "flow/path.jsonl",
                );
            }
            state = parseFlowState<string>({ position: null, path: [], params: record.params });
            continue;
        }
        if (record.op === "finish") {
            if (state.done === true) {
                throw new FlowError("invalid-state", "path.jsonl 里有两条 finish 记录（收尾只能一次）：日志自相矛盾", "flow/path.jsonl");
            }
            state = applyFinish(state);
            continue;
        }
        if (state.done === true) {
            throw new FlowError(
                "invalid-state",
                "path.jsonl 里有一条 advance 记录出现在 finish 之后：收尾后不该再有位置变更（终端节点没有 next 出边）—— 日志自相矛盾",
                "flow/path.jsonl",
            );
        }
        const request: AdvanceRequest<string> = record.ref === undefined
            ? { to: record.to, at: record.at }
            : { to: record.to, at: record.at, ref: record.ref };
        state = advance(def, state, request).state;
    }
    return state;
}

/**
 * 对账：`state.json`（权威）与 `path.jsonl`（重建材料）必须**同形**，否则亮错。
 *
 * 比较的是**规范化文本**（两侧都过一遍 `flowStateToJson`）：手改缩进不算分歧（那是排版），
 * 而多一条 / 少一条驻留、参数值不同、`done` 对不上都算 —— 此时**绝不静默以某一份为准**。
 * 返回权威快照（对账通过后调用方才继续用它跑）。
 */
export function assertSnapshotMatches(def: WorkflowDef<string>, uri: string, state: FlowState<string>): void {
    const rebuilt = rebuildState(def, readPathRecords(uri));
    const left = flowStateToJson(rebuilt);
    const right = flowStateToJson(state);
    if (left !== right) {
        throw new FlowError(
            "invalid-state",
            `按 path.jsonl 重建出的领域态与 state.json 不一致（${flowDir(uri)}）：\n` +
                `  重建：${left.replace(/\s+/g, " ")}\n  快照：${right.replace(/\s+/g, " ")}`,
            "flow/state.json",
        );
    }
}

// ═══════════════════════════════════════════════════════════════
// 产物袋（##337）：读 / 写
// ═══════════════════════════════════════════════════════════════

/** 产物袋的内容：下标 = 驻留 `seq` − 1 的 raw 列表（`null` = 该驻留无产物）；越界同样算「无产物」 */
export type ArtifactBag = unknown[];

/**
 * 读一份产物袋。
 *
 * 立场（「**无**」与「**坏**」不是一回事 —— 与 `readBinding` / `readState` 同一套）：
 *   · **文件不存在** ⇒ `[]`：没放过产物是**正常态**（产物不是领域态，本就不必存在）；
 *   · **文件在但读不出 / 不是数组** ⇒ **抛**：袋只有一个写入口，读不出就是放的人写坏了 ——
 *     静默当成「没有产物」会让坏袋永远不被发现（而它正被人当「这一步的产物」看着）。
 */
export function readArtifacts(uri: string, nodeId: string): ArtifactBag {
    const file = artifactFile(uri, nodeId);
    if (!existsSync(file)) return [];
    let raw: unknown;
    try {
        raw = readJson(file);
    } catch (e) {
        throw new Error(
            `产物袋不是合法 JSON：${file}（产物不是领域态 —— 删掉它不影响推进，修好或删掉再放）—— ${(e as Error).message}`,
        );
    }
    if (!Array.isArray(raw)) {
        throw new Error(`产物袋应为 JSON 数组（下标 = 该节点第 n 次驻留 − 1）：${file}`);
    }
    return raw;
}

/** 放一份 raw 到 `index`（0-based = 驻留 seq − 1）；中间缺的项补 `null`（= 那些驻留无产物） */
export function writeArtifact(uri: string, nodeId: string, index: number, raw: unknown): void {
    const bag = readArtifacts(uri, nodeId);
    while (bag.length < index) bag.push(null);
    bag[index] = raw;
    writeFileAtomic(artifactFile(uri, nodeId), `${JSON.stringify(bag, null, 2)}\n`);
}
