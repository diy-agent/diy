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
 *   本 store 也**不**逐会话订阅 op、不替任何会话"上报有人在看"。`seenTurns` 是本地已读水位
 *   （"我读到第几轮"），只用于算"距上次看新增多少条消息"，**不回写**任何 main 侧字段。
 *
 * 【已读水位（seenTurns）】
 *   ⚠️ **单位是轮次，不是步数**（##358 口径订正：未读 = 未读**消息**数，1 轮 = 1 条），
 *   且**尺子是跨启动总轮次** = `max(注册表本进程 turnCount, 账本唯一 turnId 数)`（`totalTurnsOf`）。
 *   —— 只认注册表那个数会两处出错：① 重启归零 ⇒ 历史轮次看不见；② 写水位时写低了，
 *   点开也擦不掉（v2 载荷的 bug，用户实测）。故水位**只在账本真值到手时才写**（`pendingSeen`）。
 *   基线取该会话**第一次出现在注册表**那一刻的账本真值，此后：
 *   · 用户正在看这个会话（`task-run` tab 处于激活）→ App 侧每帧把它追到当前 ⇒ 增量恒 0；
 *   · 用户没在看 → 差值就是"你不在的时候它跑完了多少轮"（##87 那一面的落点）。
 *
 *   **已读水位要跨启动**（##358 用户拍板）：否则每次开 app 都"丢了所有进度"。
 *   落盘方案见 `loadSeen` 上方注释 —— **临时实现**，写 renderer `localStorage`。
 */

import { createSignal, untrack } from "solid-js";
import { diyService } from "../lib/rpc";
import { StopTicker } from "../lib/stop-ticker";
import { stepsNow } from "../../shared/session-overview";
import { usageLedgerStore } from "./usageLedgerStore";
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
/**
 * 已读水位的**落盘**（##358，用户 2026-10-16 拍板）。
 *
 * ⚠️ **临时实现** —— 存 renderer `localStorage`（键 `diy_sessions_seen`，见 `Caches` 视图）。
 *
 *   · 「已读」是**全局**语义（用户拍板 ②）：localStorage 按 **profile** 共享 ⇒ **落盘即全局已读**，
 *     写入侧不需要任何跨窗口同步（同 ##306 多客户端语义：窗口 ≠ 独立的人）。
 *     ⚠️ **已知限制（持久化 ≠ 同步）**：未监听 `storage` 事件 ⇒ A 窗口点开某会话后，
 *     **B 窗口内存里的水位仍是旧的**，它的 `+N` 要等 B 重载才消失。
 *     修法：`window.addEventListener("storage", …)` 收到后重载水位；本次不做（多窗口同盯一个会话
 *     不是当前主场景），记在这里免得下一个人把"共享一份"误读成"实时一致"。
 *   · 为何不落 `$DIY_HOME` 侧车文件：本次只要"这台机器别再丢进度"。将来若要让 CLI / web 端点
 *     也读到同一份水位，**另开任务**升级为 `$DIY_HOME` 侧车文件，届时本 key 只作迁移源。
 *     **别在这里偷偷加 durable 语义**。
 *   · 仍然是 **renderer 本地量**，**不回写** `viewers`（R3 不破）。
 *
 * 写入时机：① 首次见到某会话（记基线，`syncSeenBaseline`）② `markViewed`（点开看过）。
 * ⇒ 只要会话在本次启动里进过注册表，水位就有落盘；重开 app 读到旧水位 ⇒ 未读不会凭空归零。
 * （窗口根本没开的时段里跑完的会话无从得知 —— main 侧注册表本身是进程性的，属设计内。）
 */
const SEEN_STORAGE_KEY = "diy_sessions_seen";

/**
 * 载荷版本（##358 口径订正）：
 *   v1 = 值记**步数**（旧）· v2 = 值记**轮次，但写入方只看注册表** · v3 = 值记轮次，且写入方以**账本真值**为准。
 *
 * v2 为什么也要丢：它的**单位**没错，错在**尺子**。注册表的 `turnCount` 是**本进程**的计数，
 * 重启归零；而读侧（账本）数的是**全历史**的轮次。同一行 v2 水位 = 注册表口径（可能 0），
 * 与账本口径（比如 2）一比就凭空生出「+2 未读」，且**点开也擦不掉**（写回的还是注册表那个 0）
 * —— 用户实测到的正是这个（##358 微调轮 8）。
 * ⇒ 单位/语义变过的一律当无效丢弃，宁可从"已对话"重新起算，也不留一个会撒谎的数。
 */
const SEEN_PAYLOAD_VERSION = 3;

function loadSeen(): Map<string, number> {
    try {
        const raw = localStorage.getItem(SEEN_STORAGE_KEY);
        if (!raw) return new Map();
        const obj: unknown = JSON.parse(raw);
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) return new Map();
        const rec = obj as Record<string, unknown>;
        // 只认带对版本号的载荷；旧格式（扁平 {uri: 步数} / 版本号不符）当无效丢弃
        if (rec.v !== SEEN_PAYLOAD_VERSION || !rec.seen || typeof rec.seen !== "object") return new Map();
        const m = new Map<string, number>();
        for (const [uri, v] of Object.entries(rec.seen as Record<string, unknown>)) {
            if (typeof v === "number" && Number.isFinite(v)) m.set(uri, v);
        }
        return m;
    } catch (e) {
        // 读不到（隐私模式 / 脏数据）就当没记录：宁可从零开始，也不能让 store 起不来
        console.warn("[sessions] 读取已读水位失败，按空处理:", e);
        return new Map();
    }
}

function persistSeen(m: Map<string, number>): void {
    try {
        localStorage.setItem(
            SEEN_STORAGE_KEY,
            JSON.stringify({ v: SEEN_PAYLOAD_VERSION, seen: Object.fromEntries(m) }),
        );
    } catch (e) {
        console.warn("[sessions] 持久化已读水位失败（不影响本次运行）:", e);
    }
}

/** 改内存水位 + 落盘：**唯一写入口** —— 两件事必须一起发生，别只调 `setSeen` */
function commitSeen(next: Map<string, number>): void {
    setSeen(next);
    persistSeen(next);
}

const [seen, setSeen] = createSignal<Map<string, number>>(loadSeen());
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
    if (prev === undefined) ensureBaseline(key, e);
    else if (ledgerMoved(prev, e)) usageLedgerStore.refresh(key);
    return next;
}

/**
 * 这一帧是否说明**账本又长了一行**（跑完了轮 / 走完了一步）。
 *
 * 判据只看"轮次 / 步数"这类**单调计数**，不看 `lastActivity` / `lastOpAt` ——
 * 后者每步心跳都在变，拿它当判据会把账本读成心跳频率（read amplification）。
 */
function ledgerMoved(a: SessionEntry, b: SessionEntry): boolean {
    return a.turnCount !== b.turnCount || stepsNow(a) !== stepsNow(b);
}


/**
 * 「水位待写」：这些 uri **该记水位，但账本真值还没到货**（`turnsOf` = undefined）。
 *
 * 为什么必须挂起而不是先写个近似的：注册表的 `turnCount` 是**本进程**计数（重启 0），
 * 拿它当基线写下去，等账本到货（比如 2 轮）就凭空多出 `+2` 未读 —— 而写回时又只写注册表那个 0
 * ⇒ **永远擦不掉**（用户实测的 bug）。宁可不写，等真值。
 */
const pendingSeen = new Set<string>();

/** 写水位（值 = `uri` 的**总轮次真值**）。唯一写入口：写内存 + 落盘两件事必须一起发生 */
function writeSeen(uri: string, turns: number): void {
    const cur = untrack(seen);
    if (cur.get(uri) === turns) return;
    const next = new Map(cur);
    next.set(uri, turns);
    commitSeen(next);
}

// 账本到货 → 补写挂起的水位（见 pendingSeen）
usageLedgerStore.onFacts((uri) => {
    if (!pendingSeen.has(uri)) return;
    pendingSeen.delete(uri);
    const total = totalTurnsOf(uri);
    if (total !== undefined) writeSeen(uri, total);
});

/**
 * 会话**总轮次** —— 未读水位唯一的尺子（`max(注册表本进程 turnCount, 账本唯一 turnId 数)`）。
 *
 * 为什么必须取大：两个数**单位相同**（1 轮），但覆盖的时间窗不同 —— 注册表只有本进程、
 * 重启归零；账本落盘、含全历史。取大即"谁知道的更全用谁"，且跨启动单调递增（水位才有意义）。
 * `undefined` = **账本还没读到**（≠ 0！）：水位只在知道真值时写。
 */
function totalTurnsOf(uri: string, known?: SessionEntry | null): number | undefined {
    const ledger = usageLedgerStore.turnsOf(uri);
    if (ledger === undefined) return undefined;
    /**
     * ⚠️ `known` = 调用方手上那条**尚未落进 `table()`** 的条目。
     * 为什么必须能传：`ensureBaseline` 是在 `put()` **插入新条目之前**调用的（那是它唯一的机会
     * —— 条目一落表，`seen` 就该有基线了），此刻 `table().get(uri)` 还看不到它 ⇒ 在跑的轮次
     * 减不掉、`turnCount` 也读成 0 ⇒ 基线算高（把在跑的那轮当成已收尾）⇒ 它真收尾时 `+N` 恒 0。
     */
    const e = known !== undefined ? known : table().get(uri);
    /**
     * ⚠️ **减掉在跑的那一轮**：账本每步一条账，所以**轮次还没收尾就已经被记进去了**
     * （`turnId` 已出现）—— 直接采用就是"提前宣告一轮完成"。后果实测过（##358 轮 13 记的隐患 1）：
     * 你此刻开着这个会话看，水位会把这**在跑的一轮**记成已读；等它真收尾（尤其**异常收尾**）时
     * `+N` 恒为 0 —— 恰恰是"跑失败了却没提示"。
     * 注册表的 `turnCount` 只数**已收尾**的轮次，故减 1 后两把尺子同口径（都只数收尾的）。
     * 账本还没记这轮（第一步都没走完）时减多是**偏保守**：未读少算，不虚报。
     */
    const inflight = e && e.turn !== null ? 1 : 0;
    return Math.max(e?.turnCount ?? 0, ledger - inflight);
}

/**
 * 已读水位基线：**首次见到**某会话时，把它记到此刻的**账本真值**上
 * （否则"新增"会把开应用之前的轮次也算成"你不在时跑的"，那是假事实）。
 * 账本还没到货 → 挂起（`pendingSeen`），到货再钉。
 */
function ensureBaseline(uri: string, known?: SessionEntry | null): void {
    if (untrack(seen).has(uri)) return;
    const total = totalTurnsOf(uri, known);
    if (total === undefined) {
        pendingSeen.add(uri);
        usageLedgerStore.ensure(uri);
        return;
    }
    writeSeen(uri, total);
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
    /**
     * 条目 + 它的**对外键**（任务 uri）成对给出 —— 消费者（nav 行 / 任务表 / 总览）
     * 此前各自拿 `refs.find(kind==="task")` 再算一遍，正是"同一个会话几处各算一遍 key"的分叉温床。
     */
    get rows(): Array<{ uri: string; entry: SessionEntry }> {
        return entries().map((e) => ({ uri: keyOfEntry(e), entry: e }));
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
    /** 本地已读水位（"我读到第几轮"；单位 = 轮次，##358 口径订正） */
    seenTurnsOf(uri: string): number | null {
        return seen().get(uri) ?? null;
    },
    /** 跨启动总轮次（注册表 ∪ 账本）；`undefined` = 账本还没读到（≠ 0） */
    turnsOf(uri: string): number | undefined {
        return totalTurnsOf(uri);
    },
    /**
     * **未读轮次**（1 轮 = 1 条未读消息）。三处消费者（nav chip / 任务表 / 总览）都用它，
     * 免得"读了 chip 的判据、自己又算一遍未读"那种分叉。
     * 没有水位记录（从没读过、或旧口径已丢弃）→ 0：**不知道就不虚报未读**。
     */
    unreadTurnsOf(uri: string): number {
        const s = seen().get(uri);
        if (s === undefined) return 0;
        const total = totalTurnsOf(uri);
        if (total === undefined) return 0;
        return Math.max(0, total - s);
    },
    /**
     * 记下"我看过这个会话到此刻"。
     *
     * 只有**正在看**的会话该被追平（App 侧对当前激活的 task-run tab 调用）—— 
     * 若对所有条目无条件追，等于"看一次全库都算已读"。
     *
     * ⚠️ **读水位必须 untrack**（##308 review3 P1-1，回归见 tests/core/session-store.test.ts）：
     * 本方法是给 App 的 `createEffect` 在**tracked 作用域**里调的，而 Solid 的
     * `updateComputation` 会先把那个 effect `cleanNode`（依赖 state 归零）再跑 fn ——
     * 若此处读了 `seen()`，该 effect 就注册成水位的观察者，紧随其后的 `setSeen` 会把它
     * **重新入队** ⇒ effect → 读 seen → 写 seen → 再跑…… 递归到栈溢出（RangeError）。
     * 真机症状**不是**"界面难看"，而是**订阅自杀**：异常从帧处理里抛出 → 被 `connect()` 的
     * catch 当成流断 → `connection="down"` + 退避重连（[5] 要的"实时"直接失效），
     * 且 `diy ui tab open …` 当场报 `Maximum call stack size exceeded`。
     * 水位是**写**侧本地量（"我读到哪"）——本就不该让调用方订阅它。
     *
     * 注意上面读 `table()` **不** untrack：帧到了调用方本就该重跑（这一条正是"水位随帧前进"）。
     */
    markViewed(uri: string): void {
        // 水位 = **总轮次真值**（##358：1 轮 = 1 条未读消息；不是步数）。
        // ⚠️ 只认 `turnsOf`（注册表 ∪ 账本），不认注册表单独的 `turnCount` —— 那是本进程计数，
        //    比它写下去会让"读过"这件事在账本口径下依然显得未读（用户实测：点开还是 +2）。
        const total = totalTurnsOf(uri);
        if (total === undefined) {
            // 账本还没到货：挂起，到货再写（见 pendingSeen / onFacts）
            pendingSeen.add(uri);
            usageLedgerStore.ensure(uri);
            return;
        }
        writeSeen(uri, total);
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
        // stop() 清过内存 → 重订时重新读盘（首次 start 时模块已 load 过，这里幂等且便宜）
        setSeen(loadSeen());
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
        // 只清内存：**不动 localStorage** —— 水位是跨启动量，关窗/重订不该把它抹掉
        setSeen(new Map());
        pendingSeen.clear();
    },
};
