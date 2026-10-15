/**
 * sessionStore — **全局会话可见性**的唯一数据源（##308）。
 *
 * 一条 `agent.local.sessions({ watch: true }) 订阅喂三处消费者：
 *   ① 总览页（导航「会话」）· ② nav 上的「会话」角标 + 已打开任务 tab 的 chip · ③ 任务表的行内 chip。
 *
 * 【为什么必须共用一份（##308 定案）】
 *   三处若各订阅、各算状态，同一会话必然在某处显示成别的样子（"nav 说在跑、任务表说空闲"）。
 *   故：**全应用只此一个注册表订阅**，判据全走 `shared/session-overview` 的纯函数，渲染只负责画。
 *
 * 【R3 观测不污染】
 *   注册表订阅**不计入 `viewers`**（main 侧结构性保证，见 session-registry 的头注）：看状态 ≠ 看内容。
 *   本 store 也**不**逐会话订阅 op、不替任何会话"上报有人在看"。`seenSteps` 是本地已读水位
 *   （"我读到哪一步"），只用于算"距上次看新增多少步"，**不回写**任何 main 侧字段。
 *
 * 【已读水位（seenSteps）】
 *   基线取该会话**第一次出现在注册表**那一刻的步数（= 打开应用时的快照），此后：
 *   · 用户正在看这个会话（`task-run` tab 处于激活）→ App 侧每帧把它追到当前 ⇒ 增量恒 0；
 *   · 用户没在看 → 差值就是"你不在的时候它跑了多少步"（##87 那一面的落点）。
 *   刻意**不落盘**：它是"本次会话内我读到哪"的观测量，刷新后重算即可（注册表本身也是纯内存）。
 */

import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";
import { StopTicker } from "../lib/stop-ticker";
import { sessionChipOf, stepsNow, type SessionChipView } from "../../shared/session-overview";
import type { RegistryFrame, SessionEntry } from "../../shared/registry-frame";

export type SessionConnection = "connecting" | "live" | "down";

/** 条目的对外键：任务会话用它关联的 task uri；无任务引用（插件类，形状已留）退回会话 id */
function keyOfEntry(e: SessionEntry): string {
    return e.refs.find((r) => r.kind === "task")?.uri ?? e.id;
}

/**
 * 条目内容是否真的变了。
 *
 * 为什么需要：帧里推的是**完整条目**（每次都是新对象），而 `<For>` 按**引用**认行 ——
 * 直接换对象会让「一次心跳」把整张表连同 DOM 推倒重建（闪、丢 hover、丢滚动）。
 * 故比一遍内容：没变就沿用旧引用（等价于"这一帧什么都没发生"）。
 * 条目很小（十来个字段），序列化比较最省心、也最不会漏字段。
 */
function entryEqual(a: SessionEntry, b: SessionEntry): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

const [table, setTable] = createSignal<Map<string, SessionEntry>>(new Map());
const [seen, setSeen] = createSignal<Map<string, number>>(new Map());
const [connection, setConnection] = createSignal<SessionConnection>("connecting");
const [nowMs, setNowMs] = createSignal(Date.now());
/** 单轮步数上限（监控参考项；`null` = 还没读到，界面只显示已跑步数） */
const [maxSteps, setMaxSteps] = createSignal<number | null>(null);

/**
 * 秒表：只在「有会话在跑」时走（不空转）。
 *
 * 用途 = 已跑时长 / 无进展（`stalledOf`）—— 两者都随**现在**前进才成立；没有在跑的会话时
 * 界面上的时长全是静态的，走表毫无意义。模式照 `lib/stop-ticker`（同一件事只此一种做法）。
 */
const ticker = new StopTicker(() => setNowMs(Date.now()), { intervalMs: 1000 });

let abort: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 1000;

/** 合并一条入口（保持对象引用稳定，见 `entryEqual`） */
function put(map: Map<string, SessionEntry>, e: SessionEntry): Map<string, SessionEntry> {
    const key = keyOfEntry(e);
    const prev = map.get(key);
    if (prev && entryEqual(prev, e)) return map;
    const next = new Map(map);
    next.set(key, e);
    syncSeenBaseline(key, e, prev === undefined);
    return next;
}

/**
 * 已读水位基线：**首次见到**某会话时把它记到当前步数（否则"新增"会把开应用之前的步数
 * 也算成"你不在时跑的"，那是假事实）。
 */
function syncSeenBaseline(key: string, e: SessionEntry, first: boolean): void {
    if (!first) return;
    const cur = seen();
    if (cur.has(key)) return;
    const next = new Map(cur);
    next.set(key, stepsNow(e));
    setSeen(next);
}

function applyFrame(frame: RegistryFrame): void {
    if (frame.kind === "snapshot") {
        let map = new Map<string, SessionEntry>();
        for (const e of frame.entries) map = put(map, e);
        setTable(map);
    } else if (frame.kind === "upsert") {
        setTable((m) => put(m, frame.entry));
    } else {
        const key = frame.id;
        setTable((m) => {
            if (!m.has(key)) return m;
            const next = new Map(m);
            next.delete(key);
            return next;
        });
    }
    syncTicker();
}

/** 有在跑的会话 → 走表；没有 → 停表（并顺手对一次表，让时长/停滞立刻准） */
function syncTicker(): void {
    const working = entries().some((e) => e.turn !== null);
    setNowMs(Date.now());
    ticker.sync(working);
}

/** 全量条目（按首次见到的时间排 = 人读顺序，与 main 的快照同序） */
function entries(): SessionEntry[] {
    return [...table().values()].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
}

function scheduleReconnect(): void {
    if (reconnectTimer) return;
    setConnection("down");
    const wait = backoffMs;
    backoffMs = Math.min(backoffMs * 2, 30_000);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, wait);
}

function connect(): void {
    const ctrl = new AbortController();
    abort = ctrl;
    setConnection((c) => (c === "live" ? c : "connecting"));
    void (async () => {
        try {
            const stream = await diyService.diy.agent.local.sessions({ watch: true }, { signal: ctrl.signal });
            for await (const frame of stream) {
                // 已被重订（旧流作废）：别拿旧帧去撞新表
                if (abort !== ctrl) break;
                // "通了"的判据是**收到帧**（不是调用返回）：注册表首帧恒为 snapshot
                if (connection() !== "live") {
                    backoffMs = 1000;
                    setConnection("live");
                }
                applyFrame(frame as RegistryFrame);
            }
            // 循环正常退出 = main 把流关了（订阅没了 = 实时没了），不能当"无事发生"
            if (abort === ctrl) {
                console.warn("[sessions] 注册表订阅被 main 关闭，将退避重连");
                scheduleReconnect();
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // 主动退订（窗口销毁）与传输中断分流：前者不是故障
            if (!ctrl.signal.aborted && !/disposed|abort/i.test(msg)) {
                console.warn("[sessions] 注册表订阅中断，将退避重连:", e);
                scheduleReconnect();
            }
        }
    })();
}

/** 读一次生效限制（`maxSteps` 是监控参考项；页面能改，见 setMaxSteps） */
async function loadLimits(): Promise<void> {
    try {
        const r = await diyService.diy.agent.local.limits({});
        setMaxSteps(r.maxSteps);
    } catch (e) {
        // 读不到就不画上限（宁可不显示，也不编一个 200）
        console.warn("[sessions] 读取运行限制失败:", e);
    }
}

export const sessionStore = {
    /** 本次启动后活跃过的会话（快照 + 增量） */
    get entries(): SessionEntry[] {
        return entries();
    },
    get connection(): SessionConnection {
        return connection();
    },
    get nowMs(): number {
        return nowMs();
    },
    get maxSteps(): number | null {
        return maxSteps();
    },
    /** 在跑的会话数（nav 角标用） */
    get workingCount(): number {
        return entries().filter((e) => e.turn !== null).length;
    },
    /** 按任务 uri 取条目（三处消费者的统一入口） */
    byUri(uri: string): SessionEntry | null {
        return table().get(uri) ?? null;
    },
    /** 本地已读水位（"我读到哪一步"） */
    seenStepsOf(uri: string): number | null {
        return seen().get(uri) ?? null;
    },
    /**
     * 记下"我看过这个会话到此刻"。
     *
     * 只有**正在看**的会话该被追平（App 侧对当前激活的 task-run tab 调用）—— 
     * 若对所有条目无条件追，等于"看一次全库都算已读"。
     */
    markViewed(uri: string): void {
        const e = table().get(uri);
        if (!e) return;
        const next = new Map(seen());
        next.set(uri, stepsNow(e));
        setSeen(next);
    },
    /** 三处消费者共用的 chip 判据（`null` = 没什么可说的，调用方不渲染） */
    chipOf(uri: string): SessionChipView | null {
        const e = table().get(uri);
        if (!e) return null;
        return sessionChipOf(e, { seenSteps: seen().get(uri) ?? null, maxSteps: maxSteps(), now: nowMs() });
    },
    /** 改单轮步数上限（走 [4] 的写 RPC：写文件 + 即时失效缓存 → **下一轮生效**） */
    async setMaxSteps(n: number): Promise<void> {
        try {
            // 入参形状六个键齐全（可选 = 允许 undefined）；这里**只写真改的那个**，
            // 其余 undefined 会被 handler 的"逐键判有限正数"忽略 ⇒ 不动别的开关。
            const r = await diyService.diy.agent.local.setLimits({
                maxSteps: n,
                maxOutputTokens: undefined,
                bashTimeoutMs: undefined,
                outputClipChars: undefined,
                readMaxBytes: undefined,
                maxSteerQueue: undefined,
            });
            setMaxSteps(r.maxSteps);
        } catch (e) {
            console.error("[sessions] 写运行限制失败:", e);
            throw e;
        }
    },
    /** 起订阅（App 挂载时一次；重复调用幂等） */
    start(): void {
        if (abort) return;
        connect();
        void loadLimits();
    },
    /** 停订阅（窗口销毁 / 测试收尾） */
    stop(): void {
        abort?.abort();
        abort = null;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        ticker.stop();
        setConnection("connecting");
        setTable(new Map());
        setSeen(new Map());
    },
};
