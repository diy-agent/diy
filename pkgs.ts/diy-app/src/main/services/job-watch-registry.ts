// src/main/services/job-watch-registry.ts
// 🎯 JobWatch 的**执行端**（##408 v2）：把定义落盘、每拍挑出该探的、比指纹、变了就投。
//
// 判据全在 `shared/job-watch.ts`（`isDue` / `probeSucceeded` / `probeFailed` / `diffParts`），
// 本文件只做四件事：
//   ① 落盘：`$DIY_HOME/jobs/watch/defs/<id>.json` + `state/<id>.json`（home 走 `runtime.ts`）
//   ② 探测：把 `glob:gen/**` 这类说明符跑成 `ProbePart[]`（**纯代码零模型**）
//   ③ 挑拍：`isDue` 说该探的才探；探测失败只累积 `errorStreak`，不炸 tick
//   ④ 投递：`changed` 时才调 `deliver`（缺省打日志；接 local-agent 是下一刀的事）
//
// 为什么状态要落盘（与 ##408 v1「不留审计账」不矛盾）：v1 那句话说的是**进程 run**——
// 重启后进程已经死了，记着它没有意义。watch 不一样：它的价值正是「停机两天回来，
// 第一拍把这两天的变化一次说完」。所以这里存的不是历史，是**一行基线**（上次指纹）。
//
// 坏文件忍让：坏 JSON / 缺字段 / 手改过的定义一律**跳过并继续**（`loadDefs` 返回读到的
// 那些）。观测数据可以腐烂，但腐烂不该让一个 watch 拖死全部。

import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { readRuntimeConfig } from "../../runtime";
import { writeFileAtomic } from "../core/atomic-write";
import { coreTicker } from "./core-ticker";
import type { CoreTicker } from "./core-ticker";
import {
    EMPTY_WATCH_STATE,
    JobWatchError,
    isBroken,
    isDue,
    probeFailed,
    probeSucceeded,
    validateWatchDef,
} from "../../shared/job-watch";
import type { JobWatchDef, JobWatchState, ProbePart } from "../../shared/job-watch";

/** 探针执行器：`spec` → 若干段事实。抛错 = 这次探测失败。 */
export type ProbeRunner = (spec: string, ctx: { home: string; now: number }) => Promise<ProbePart[]>;

/** 变化投递：缺省实现只打一行日志（接 local-agent / 房间消息是下一刀）。 */
export type WatchDeliver = (def: JobWatchDef, diff: string, now: number) => void | Promise<void>;

export interface JobWatchRegistryOptions {
    /** 落盘根；缺省 `$DIY_HOME/jobs/watch` */
    rootDir?: string;
    /** 探针的工作根（glob 的 cwd）；缺省 = 数据根 */
    home?: string;
    now?: () => number;
    probe?: ProbeRunner;
    deliver?: WatchDeliver;
}

export interface WatchTickReport {
    /** 定义总数 */
    readonly watches: number;
    /** 这一拍到点该探的 */
    readonly due: number;
    /** 探测成功 */
    readonly probed: number;
    /** 探测失败（含连续失败已标记 broken 的） */
    readonly failed: number;
    /** 指纹变了、已投递 */
    readonly changed: number;
    /** 因连续失败被标记为「这个 watch 坏了」的 id */
    readonly broken: readonly string[];
}

/**
 * 缺省探针：`glob:<pattern>`。
 *
 * 用 `fs.promises.glob`（Node 22+），**不 shell 出去跑 fd** —— 探针每拍都跑，
 * 起进程的代价比读目录高一个量级。匹配结果按路径排序后拼成一个 part：
 * 排序去掉「目录遍历顺序」这种假变化。
 */
export const globProbe: ProbeRunner = async (spec, ctx) => {
    const m = /^glob:(.+)$/.exec(spec.trim());
    if (!m) throw new JobWatchError("agent/unknown-probe", `未知探针：${spec}（v1 只支持 glob:<pattern>）`);
    const pattern = m[1];
    const fsp = await import("node:fs/promises");
    const glob = (fsp as { glob?: (p: string, o: { cwd: string }) => AsyncIterable<string> }).glob;
    if (typeof glob !== "function") throw new JobWatchError("agent/probe-unavailable", "当前 Node 不支持 fs.glob（探针不可用）");
    const hits: string[] = [];
    for await (const p of glob(pattern, { cwd: ctx.home })) hits.push(p);
    hits.sort();
    // 只给「有几条 + 前 50 条」：这是一个观察点，不是文件清单下载
    const shown = hits.slice(0, 50).join("\n");
    return [{ key: spec, value: `${hits.length}\n${shown}` }];
};

/** 连续失败达到几次就把 watch 标成 broken（与 shared 里的阈值同一口径）。 */
export class JobWatchRegistry {
    private readonly rootDir: string;
    private readonly home: string;
    private readonly now: () => number;
    private readonly probe: ProbeRunner;
    private readonly deliver: WatchDeliver;

    constructor(opts: JobWatchRegistryOptions = {}) {
        const cfg = readRuntimeConfig();
        this.rootDir = opts.rootDir ?? join(cfg.home, "jobs", "watch");
        this.home = opts.home ?? cfg.home;
        this.now = opts.now ?? (() => Date.now());
        this.probe = opts.probe ?? globProbe;
        this.deliver =
            opts.deliver ??
            ((def, diff) => {
                // 骨架阶段：只打日志。刀 3 起换成投递到 task 房间 / 唤醒 agent。
                console.log(`[job-watch] ${def.id}（${def.title}）有变化：\n${diff}`);
            });
    }

    private defsDir(): string {
        return join(this.rootDir, "defs");
    }

    private stateDir(): string {
        return join(this.rootDir, "state");
    }

    private defPath(id: string): string {
        return join(this.defsDir(), `${id}.json`);
    }

    private statePath(id: string): string {
        return join(this.stateDir(), `${id}.json`);
    }

    /** 读全部定义。坏文件 / 坏定义**跳过不抛**（返回读得懂的）。 */
    async loadDefs(): Promise<JobWatchDef[]> {
        const dir = this.defsDir();
        let names: string[];
        try {
            names = await readdir(dir);
        } catch {
            return []; // 目录还没建 = 一个 watch 都没有
        }
        const results = await Promise.allSettled(
            names
                .filter((name) => name.endsWith(".json"))
                .map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8")) as JobWatchDef),
        );
        const out: JobWatchDef[] = [];
        for (const r of results) {
            // 坏行 = 这个 watch 不存在；不因此丢掉别的
            if (r.status === "fulfilled" && !validateWatchDef(r.value)) out.push(r.value);
        }
        return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }

    async getDef(id: string): Promise<JobWatchDef | null> {
        try {
            const def = JSON.parse(await readFile(this.defPath(id), "utf8")) as JobWatchDef;
            return validateWatchDef(def) ? null : def;
        } catch {
            return null;
        }
    }

    /** 写入定义（先校验；`id` 是落盘文件名，**唯一闸门在 `validateWatchDef`**）。 */
    async saveDef(def: JobWatchDef): Promise<void> {
        const err = validateWatchDef(def);
        if (err) throw new JobWatchError("agent/invalid-watch-def", `watch 定义非法：${err}`);
        await mkdir(this.defsDir(), { recursive: true });
        writeFileAtomic(this.defPath(def.id), `${JSON.stringify(def, null, 4)}\n`);
    }

    /** 删定义 + 状态（幂等：不存在也算删成功）。 */
    async removeDef(id: string): Promise<boolean> {
        const existed = await Promise.all([stat(this.defPath(id)), stat(this.statePath(id))]).then(
            () => true,
            () => false,
        );
        await rm(this.defPath(id), { force: true });
        await rm(this.statePath(id), { force: true });
        return existed;
    }

    /** 读状态；坏文件 / 不存在 ⇒ 空状态（等于「还没探过」）。 */
    async getState(id: string): Promise<JobWatchState> {
        try {
            const raw = JSON.parse(await readFile(this.statePath(id), "utf8")) as Partial<JobWatchState>;
            // 逐字段兜底：手改过的 state 不该让下一拍崩
            return {
                fingerprint: typeof raw.fingerprint === "string" ? raw.fingerprint : null,
                lastParts: Array.isArray(raw.lastParts) ? (raw.lastParts as ProbePart[]) : null,
                lastProbeAt: typeof raw.lastProbeAt === "number" ? raw.lastProbeAt : null,
                lastChangeAt: typeof raw.lastChangeAt === "number" ? raw.lastChangeAt : null,
                quietStreak: typeof raw.quietStreak === "number" ? raw.quietStreak : 0,
                probes: typeof raw.probes === "number" ? raw.probes : 0,
                errorStreak: typeof raw.errorStreak === "number" ? raw.errorStreak : 0,
                lastError: typeof raw.lastError === "string" ? raw.lastError : null,
            };
        } catch {
            return EMPTY_WATCH_STATE;
        }
    }

    /** 写状态（目录按需建；原子写，与 `task edit` 同一条腿）。 */
    async saveState(id: string, state: JobWatchState): Promise<void> {
        await mkdir(this.stateDir(), { recursive: true });
        writeFileAtomic(this.statePath(id), `${JSON.stringify(state, null, 4)}\n`);
    }

    /**
     * 跑一拍：挑出到点的 watch，逐个探测 / 比对 / 投递。
     *
     * **不抛**：单个 watch 的失败记在它自己的 state 里（`errorStreak`），
     * 一拍结束照样返回报告 —— 定时器里的一个坏住户不该带走其他人。
     */
    async tickAll(): Promise<WatchTickReport> {
        const defs = await this.loadDefs();
        const now = this.now();
        const states = new Map(await Promise.all(defs.map(async (d) => [d.id, await this.getState(d.id)] as const)));
        const due = defs.filter((d) => isDue(d, states.get(d.id)!, now));
        let probed = 0;
        let failed = 0;
        let changed = 0;
        const broken: string[] = [];

        await Promise.all(
            due.map(async (def) => {
                const state = states.get(def.id)!;
                try {
                    const parts: ProbePart[] = [];
                    for (const spec of def.probes) parts.push(...(await this.probe(spec, { home: this.home, now })));
                    const outcome = probeSucceeded(def, state, parts, now);
                    await this.saveState(def.id, outcome.state);
                    probed += 1;
                    if (outcome.verdict === "changed") {
                        changed += 1;
                        await this.deliver(def, outcome.diff, now);
                    }
                } catch (e) {
                    const next = probeFailed(state, e instanceof Error ? e.message : String(e), now);
                    await this.saveState(def.id, next);
                    failed += 1;
                    if (isBroken(next)) broken.push(def.id);
                }
            }),
        );

        return { watches: defs.length, due: due.length, probed, failed, changed, broken };
    }
}

/** 进程级单例（首次 `job.watch.*` 调用时懒建）。 */
let singleton: JobWatchRegistry | null = null;

export function jobWatchRegistry(): JobWatchRegistry {
    singleton ??= new JobWatchRegistry();
    return singleton;
}

/**
 * 把 watch 挂到**唯一一拍源**上（主进程启动时调一次）。
 *
 * 两件事：
 *   ① 启动**立刻**探一拍 —— 否则第一个 watch 要等 60s 才建基线，而基线越早越准；
 *   ② 之后随每拍 `tickAll()`（到点的才探，见 `isDue`）。
 *
 * 返回退订函数（Electron 退出 / 测试收尾用）。重复调用 = 重复订阅同名键 ⇒ 替换，
 * 不会两拍跑两遍（`CoreTicker.subscribe` 的语义）。
 */
export function startJobWatches(
    ticker: CoreTicker = coreTicker,
    registry: JobWatchRegistry = jobWatchRegistry(),
): () => void {
    void registry.tickAll();
    return ticker.subscribe("job-watch", async () => {
        await registry.tickAll();
    });
}
