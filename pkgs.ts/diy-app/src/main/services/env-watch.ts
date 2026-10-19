// src/main/services/env-watch.ts
// 🎯 「环境感知」通知中心（##384）—— 机器环境坏了（磁盘满 / 网断）时，把这条事实从
//    **沉默**变成**顶栏红条**，且**带数字**。
//
// 为什么需要独立一处：2026-10-18 满盘把 ##166 正文写成 0 字节、2026-10-19 ##377 会话两次
// 「脚本说成功、文件里却没有」—— 症状都是「卡住」，用户与 agent 都只能靠 `du` / `lsof` 猜。
// 失败本来只落在某个写调用 / 某个流里，而"机器现在怎么了"是**进程级**事实：与具体任务、
// 具体会话无关。故它不是任何任务日志的一部分。
//
// 数据定性 = **cache**（`rule.core-log` 同一原则）：进程内存 ring，重启即空 —— 它描述的是
// 「此刻环境怎么了」，不是历史账；要追溯去看 `~/.diy/log/network/*.jsonl` 与会话流。
//
// 判据不在本文件：**唯一判据**是 shared/env-watch.ts 的纯函数（表驱动单测在
// tests/core/env-watch.test.ts）。本文件只做四件事：
//   ① 主动轮询磁盘水位（`fs.statfs`，**不 shell 出去跑 `df`**）
//   ② 收被动事实（写失败 ENOSPC / 网络层错误码）→ 交给判据
//   ③ 把通知写进 ring + 广播（同 type 只留最新一条）
//   ④ **自动消**：条件恢复（水位回 ok / 一次请求成功）时撤掉对应通知，不要用户手动关
//
// 与 model-notice 的关系（##384 §2.6 的取舍）：**各留一份同构实现**。
// 理由：两者的**生命周期语义不同** —— model-notice 是"一次失败一条事实，用户关掉即了"；
// 这里是"条件持续存在 → 通知持续存在，条件消失 → 通知自己消失"（自动消是硬要求）。
// 硬塞进同一个 hub 就得在 hub 里长出两套 dismiss 规则（谁该被回放、谁该被自动撤），
// 而那正是"bar 层长出两套逻辑"的坏结果。重复的只有十几行 ring 代码，收益是语义各自清晰。
//
// 关闭语义（与 model-notice 刻意不同，**这条是用户视角的硬要求**）：
//   ✕ = 「这个条件我知道了」→ 该类通知**静音**，条件不变就不再弹（否则轮询每 30s 弹一次，
//   ✕ 等于没关）；条件恢复后静音解除，下次再坏才重新提醒。升级不受静音影响
//   （`disk-low` 静音了，恶化成 `disk-full` 仍然要亮 —— 那是另一件更急的事）。

import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { AsyncQueue, withCleanup } from "./async-queue";
import {
    envNoticeFromDisk,
    envNoticeFromNetwork,
    envNoticeFromWriteError,
    probeNetworkError,
    classifyNetworkError,
    NETWORK_FAIL_STREAK,
    slotOf,
    type DiskSample,
    type EnvNotice,
    type EnvNoticeEvent,
} from "../../shared/env-watch";

/** ring 上限：bar 最多堆 3 条 + 折叠计数，留一小段历史够 CLI 排查即可 */
const MAX_NOTICES = 20;

/** 磁盘轮询缺省间隔（ms）：`statfs` 是纯元数据调用，廉价；30s 足够抓到"瞬态满盘" */
export const DEFAULT_DISK_POLL_MS = 30_000;
/** 轮询间隔下限：防止配置写 0 变成忙轮询（测试用 1s 也是靠它兜住） */
export const MIN_DISK_POLL_MS = 1_000;

/** 探测目标的注入点（单测 / 意图测试用它换掉真卷，**绝不去填满根卷**） */
export interface EnvWatchProbe {
    /** 采一次磁盘水位（`mount` = 被探测的路径） */
    statfs(path: string): Promise<DiskSample>;
    /** 轮询间隔（ms） */
    intervalMs?: number;
}

/** 真实现：`fs.statfs`（Node 18.15+）。别 shell 出去跑 `df` —— 那是每 30s 起一个进程。 */
export async function realStatfs(path: string): Promise<DiskSample> {
    const s = await statfs(path, { bigint: true });
    // bavail = 非特权用户可用块数（**不是** bfree：后者含 root 预留，会高估可用空间）
    return { mount: path, availBytes: Number(s.bavail * s.bsize), totalBytes: Number(s.blocks * s.bsize) };
}

/**
 * 环境通知中心：ring + fan-out 订阅 + **按 type 自动消 / 静音**。
 */

class EnvWatchHub {
    private notices: EnvNotice[] = [];
    private queues = new Set<AsyncQueue<EnvNoticeEvent>>();
    /** 用户 ✕ 过的**槽**：条件不变就不再弹（见文件头「关闭语义」；按槽而非 type，见 slotOf） */
    private muted = new Set<string>();

    /**
     * 记一条通知：同一「槽」只留最新一条；被静音的槽直接跳过（不广播、不入 ring）。
     *
     * **id 复用**（条件持续期间 id 稳定）：轮询每轮都会重新采到"还是满的"，若每轮都发新 id，
     * 用户点 ✕ 就会打空 —— 界面渲染的是上一轮的 id，而轮询已经把这条换成了新 id（30s 一次，
     * 窗口小但真实；实测在 1s 轮询下必现）。故同一槽 + **同一 kind** 时沿用旧 id（只刷新数字与
     * 时刻）：这样"这条通知"= "这个条件"，dismiss / 前端 key / 去重全都稳定。
     * 槽内 **kind 变了**（`disk-low` 恶化成 `disk-full`）是新事实 → 换新 id（不该被当成同一条）。
     */
    push(n: EnvNotice): void {
        const slot = slotOf(n);
        if (this.muted.has(slot)) return;
        const prev = this.notices.find((x) => slotOf(x) === slot);
        const kept: EnvNotice = prev && prev.type === n.type ? { ...n, id: prev.id } : n;
        this.notices = this.notices.filter((x) => slotOf(x) !== slot);
        this.notices.push(kept);
        if (this.notices.length > MAX_NOTICES) this.notices.splice(0, this.notices.length - MAX_NOTICES);
        for (const q of this.queues) q.push({ kind: "upsert", data: kept });
    }

    /**
     * 磁盘条件恢复：**只撤该挂载点**的 disk-* 通知（别的卷的满盘与它无关），并解除静音。
     *
     * 为什么按挂载点而不是按 type：进程可能同时盯着多个卷（探针可指向任意路径），
     * "这个卷好了"不能顺手把另一个卷的红条也撤掉。
     */
    resolveDisk(mount: string): void {
        this.muted.delete(`disk:${mount}`);
        const gone = this.notices.filter(
            (n) => (n.type === "disk-full" || n.type === "disk-low") && n.data.mount === mount,
        );
        if (gone.length === 0) return;
        this.notices = this.notices.filter((n) => !gone.includes(n));
        for (const n of gone) for (const q of this.queues) q.push({ kind: "resolve", data: { id: n.id } });
    }

    /** 网络恢复：撤掉 network-down + 解除静音 */
    resolveNetwork(): void {
        this.muted.delete("network-down");
        const gone = this.notices.filter((n) => n.type === "network-down");
        if (gone.length === 0) return;
        this.notices = this.notices.filter((n) => n.type !== "network-down");
        for (const n of gone) for (const q of this.queues) q.push({ kind: "resolve", data: { id: n.id } });
    }

    /**
     * 用户关掉（"我知道了"）：从 ring 移除 + **静音该槽**。
     * 不给 id = 全关（bar 的批量语义）。
     *
     * 关掉也要**广播 `resolve`**：关闭可能来自**别处**（CLI `diy env dismiss`、另一个窗口），
     * 那些订阅者手上还挂着这条 —— 只改 ring 不推事件，它们会一直显示一条已不存在的通知
     * （实测踩过：CLI 关掉后 bar 仍亮，直到页面重载）。`resolve` 的含义是"这条不再有效"，
     * 恢复与关闭两种成因在消费侧行为一致（移除），故共用同一事件。
     */
    dismiss(id?: string): void {
        const gone = id ? this.notices.filter((n) => n.id === id) : [...this.notices];
        for (const n of gone) this.muted.add(slotOf(n));
        if (gone.length === 0) return;
        this.notices = this.notices.filter((n) => !gone.includes(n));
        for (const n of gone) for (const q of this.queues) q.push({ kind: "resolve", data: { id: n.id } });
    }

    /** 当前未关闭的通知（CLI `diy env ls` / 测试用） */
    list(): EnvNotice[] {
        return [...this.notices];
    }

    /** 订阅：先回放现存（页面重载后 bar 能自己回来），再收增量（含 resolve 事件） */
    subscribe(signal?: AbortSignal): AsyncIterable<EnvNoticeEvent> {
        const q = new AsyncQueue<EnvNoticeEvent>();
        for (const n of this.notices) q.push({ kind: "upsert", data: n });
        this.queues.add(q);
        return withCleanup(q, () => this.queues.delete(q), signal);
    }

    /** 测试用：清空 ring 与静音表 */
    reset(): void {
        this.notices = [];
        this.muted.clear();
    }
}

export const envWatchHub = new EnvWatchHub();

// ─── 主动轮询 ─────────────────────────────────────────

/**
 * 磁盘水位轮询器：一个进程只该有一个（重复起 = 两倍 statfs + 两倍通知）。
 *
 * 这是唯一能抓到**瞬态满盘**的路径（2026-10-19 实测：满盘后自行缓解、可用从 <50Mi 回到 166G，
 * 不轮询就永远看不见）。
 */
export class EnvDiskPoller {
    private timer: NodeJS.Timeout | null = null;
    private busy = false;

    constructor(
        private readonly probe: EnvWatchProbe,
        /** 被探测的路径（卷的任意路径都行；`statfs` 给的是它所在卷的水位） */
        private readonly target: string,
    ) {}

    start(): void {
        if (this.timer) return;
        const every = Math.max(MIN_DISK_POLL_MS, this.probe.intervalMs ?? DEFAULT_DISK_POLL_MS);
        void this.tick(); // 启动先采一次：满盘不会等你 30s
        this.timer = setInterval(() => void this.tick(), every);
        this.timer.unref?.(); // 轮询不该成为"进程退不掉"的理由
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /** 采一次 + 判据 + 推/撤通知。**失败不抛**（轮询崩了不该带走主进程） */
    async tick(): Promise<void> {
        if (this.busy) return; // 上一轮还没回来（statfs 卡住时别堆轮次）
        this.busy = true;
        try {
            const sample = await this.probe.statfs(this.target);
            const n = envNoticeFromDisk(sample, "poll");
            if (n) envWatchHub.push(n);
            // 恢复即自动消：full / low 是同一个卷的两种水位，回 ok 时**这个卷**的两条都该消失
            else envWatchHub.resolveDisk(sample.mount);
        } catch (e) {
            // 采不到 = 卷可能已经不可访问：这不是"环境正常"，但也不该伪造数字。
            // 只在日志里留一句（"写失败"由被动路径负责亮红条）。
            console.warn(`[env-watch] 磁盘水位采样失败（${this.target}）:`, e instanceof Error ? e.message : e);
        } finally {
            this.busy = false;
        }
    }
}

/**
 * 进程级单例轮询器（api-impl 懒加载；首次 `env.*` 调用时 start）。
 *
 * 为什么懒加载而不是 main/index.ts 里显式起：`serve` 模式与测试实例也走 api-impl，
 * 而它们的入口各不相同 —— 挂在这里三条入口自动都覆盖，不会漏一处。
 *
 * 注入点（探针/测试，与 `DIY_ZEN_BASE_URL` 同一性质）：
 *   · `DIY_ENV_WATCH_TARGET` —— 被探测的路径（缺省 `/`）；测试指向小容量镜像
 *   · `DIY_ENV_DISK_POLL_MS` —— 轮询间隔（缺省 30s；下限 1s）
 */
let _poller: EnvDiskPoller | null = null;
export function ensureDiskPoller(): EnvDiskPoller {
    if (!_poller) {
        const intervalMs = Number(process.env["DIY_ENV_DISK_POLL_MS"]) || undefined;
        _poller = new EnvDiskPoller(
            { statfs: realStatfs, intervalMs },
            process.env["DIY_ENV_WATCH_TARGET"] || "/",
        );
        _poller.start();
    }
    return _poller;
}

/** 测试/探针用：换掉轮询器（不填真卷） */
export function setDiskPoller(p: EnvDiskPoller | null): void {
    _poller?.stop();
    _poller = p;
    _poller?.start();
}

// ─── 被动事实 ─────────────────────────────────────────

/**
 * 网络层连败计数（进程级）：一次失败可能只是抖动，**连续 3 次**才认"断了"（判据在 shared）。
 *
 * 为什么按"轮次"计而不是按"每次 HTTP 重试"计：SDK 内部对一次请求会重试 2 次（maxRetries: 2），
 * 若按每次 HTTP 失败计数，**一轮对话失败就会立刻亮 bar** —— 那会把偶发抖动变成常态红条。
 * 按轮次计（一次对话收尾失败算一次）才符合"连续 N 次都失败"的语义。
 */
class NetworkStreak {
    private streak = 0;

    /** 一次**轮次失败**：命中网络层错误码才计数，达阈值亮 bar */
    fail(e: unknown): void {
        const probe = probeNetworkError(e);
        const v = classifyNetworkError(probe);
        if (!v.hit) return;
        this.streak++;
        const n = envNoticeFromNetwork(probe, this.streak);
        if (n) envWatchHub.push(n);
    }

    /** 一次**轮次成功**：清零 + 撤掉 network-down（恢复自动消） */
    succeed(): void {
        this.streak = 0;
        envWatchHub.resolveNetwork();
    }

    count(): number {
        return this.streak;
    }

    reset(): void {
        this.streak = 0;
    }
}

export const networkStreak = new NetworkStreak();

/**
 * **探针**：手动喂一条环境事实（`diy env simulate`）—— 只在非生产环境可用。
 *
 * 为什么需要它：真造满盘会毁现场数据、真断网会打断本机所有实例。可复现的活体验证只有
 * 这条路 —— 注入**假 statfs 水位**或**假错误码**，走的是与真事件**同一条**判据 + 同一个
 * ring + 同一个 bar（差别只在事实来源）。生产（`DIY_ENV=production`）一律拒绝，免得它变成
 * "随手造个假红条"的入口。
 */
export async function simulateEnvFact(
    fact:
        | { kind: "disk"; availBytes: number; totalBytes: number; mount?: string }
        | { kind: "network"; code: string | null; streak?: number; message?: string },
    now = new Date(),
): Promise<EnvNotice | null> {
    if (fact.kind === "disk") {
        const sample: DiskSample = {
            mount: fact.mount ?? process.env["DIY_ENV_WATCH_TARGET"] ?? "/",
            availBytes: fact.availBytes,
            totalBytes: fact.totalBytes,
        };
        const n = envNoticeFromDisk(sample, "poll", now);
        if (n) envWatchHub.push(n);
        else envWatchHub.resolveDisk(sample.mount);
        return n;
    }
    const probe = { code: fact.code, message: fact.message ?? "（探针注入）" };
    const streak = fact.streak ?? NETWORK_FAIL_STREAK;
    const n = envNoticeFromNetwork(probe, streak, now);
    if (n) envWatchHub.push(n);
    else envWatchHub.resolveNetwork();
    return n;
}

/**
 * 写失败（`err.code === "ENOSPC"`）→ **立刻**升级成 `disk-full`，不等下一轮轮询。
 *
 * 为什么单独一条路径：这条事实来自**已经发生**的写失败（##382 之后数据不会再丢，但"这次
 * 为什么写失败"必须立刻可见），而水位可能刚被腾出来（`statfs` 已经 ok）—— 若走
 * `envNoticeFromDisk` 的 `ok → null` 规则，最该亮的那一次反而会被吞掉。
 */
export async function noteWriteError(e: unknown, path?: string): Promise<void> {
    if ((e as NodeJS.ErrnoException | null)?.code !== "ENOSPC") return;
    let sample: DiskSample | null = null;
    try {
        // 采**失败的那个路径所在卷**（不是根卷）：满的是它，数字也必须说它。
        // 取 dirname：失败时目标文件可能根本不存在（新文件没写出来），
        // 而 `statfs` 对不存在的路径直接 ENOENT；父目录一定在（写之前已 mkdir -p）。
        sample = await realStatfs(path ? dirname(path) : process.env["DIY_ENV_WATCH_TARGET"] || "/");
    } catch {
        /* 读不到水位也照发（见 envNoticeFromWriteError 的理由） */
    }
    envWatchHub.push(envNoticeFromWriteError(sample));
}
