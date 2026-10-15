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
//   · `path.jsonl` 只用于**重建 / 审计**：从 `initialState()` 起把每条记录喂回内核 `advance`
//     （重建走的是**内核自己的正路**，不是本文件另写一套折叠），产物必须与快照**逐字节同形**
//     （规范化后比较，见 `assertSnapshotMatches`）。不一致 ⇒ **亮错**，绝不静默择一。
//   · `events.jsonl` 与 `$DIY_HOME/log/` 同定性：删掉、损坏都不影响运行（读侧容错 + 报计数）。
//     `path.jsonl` 不能这么办 —— 它参与对账，坏行即「重建不出快照」⇒ 必须亮错。
//
// 为什么状态不进 `state.yaml`：那是**运行中的应用独占写入**的核心状态（`data.state` 约定），
// 外部写它 = 与运行中的 app 抢同一份文件。任务目录下的 `flow/` 才是实例自己的地盘。
// 为什么是 `flow/` 而不是 `.diy/`：owner 计划 §2 明确指定（任务的系统自留地 `.diy/` 另有一套
// 归属约定，见 core/state.ts 的 taskSystemDir）。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
    readonly kind: "start" | "entry" | "next" | "bounce" | "params";
    readonly from: string | null;
    readonly to: string | null;
    readonly author: string;
    readonly content: string;
    readonly ref?: Readonly<Record<string, string>>;
}

/** 四份文件的路径（唯一出口；别处不许自己 join） */
export function flowDir(uri: string): string {
    return join(taskDir(uri), "flow");
}

export function flowFile(uri: string, name: "instance" | "state" | "path" | "events"): string {
    const file = name === "path" ? "path.jsonl" : name === "events" ? "events.jsonl" : `${name}.json`;
    return join(flowDir(uri), file);
}

/** 原子写（tmp + rename）：同目录内改名是原子操作，不会留半截文件 */
function writeFileAtomic(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, path);
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
 * 两种操作（`FlowState` 的两部分各有一种来源，缺一即「重建不出快照」）：
 *   · `config` —— 定/改本次运行的 L2 参数值（`start` 与「尚未进入时的 `params set`」）。
 *     **必须有它**：`FlowState.params` 是领域态的一部分，而位置变更（`advance`）**不产生**参数值
 *     —— 不记 config，尚未进入的实例就永远对不上账（首版实测：start 后立刻 show 即亮错）。
 *   · `advance` —— 一次位置变更（`{ to, at, ref? }`）。
 *
 * 为什么 `advance` 记录里**不写** `params`：参数值有唯一的来源（config 记录），`advance` 只做位置变更
 * （它带的那份 `params` 就是「继承状态那份」，内核据此保证正路状态自足 —— 重建走的是同一个内核，
 * 不需要把同一份值在每行复述一遍）。
 */
export type FlowPathRecord =
    | { readonly op: "config"; readonly params: Readonly<Record<string, unknown>> }
    | { readonly op: "advance"; readonly to: string; readonly at: string; readonly ref?: Readonly<Record<string, string>> };

export function appendPathRecord(uri: string, record: FlowPathRecord): void {
    const out: Record<string, unknown> = record.op === "config"
        ? { op: "config", params: record.params }
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
        throw new Error(`path.jsonl 第 ${i + 1} 行的 op 未知（只认 config / advance）：${JSON.stringify(rec["op"])}`);
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

/**
 * 按 `path.jsonl` 重建领域态 —— 走内核正路（`advance` + `parseFlowState`），不另写折叠逻辑。
 * config 记录只能在**尚未进入**时出现（内核立场：进入后换配置 = 另起一次运行）—— 违反即亮错。
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
