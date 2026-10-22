/**
 * process-health.ts — 「这个后台进程是死了还是在干活」的**本地判据**（##401 L1；纯函数、零 IO）。
 *
 * ── 为什么先本地判、再给模型 ──
 *   实测（`tasks/401/gen/exp-jev-hang/`）：把原始采样直接丢给便宜模型，它会塌缩 ——
 *   健康的一律判 `stuck`，或有连接的一律判 `network-wait`。给「显式二分判据 + 历史 p50 倍数」才 19/20。
 *   ⇒ 结论能算的**必须在本地算掉**（零 token、可复现、可单测），模型的活只剩「本地判不出的语义边界」。
 *
 * ── 三态（工程上只有两类动作）──
 *   · `stuck`        —— 进程不会自己好，**值得唤醒主模型**（唯一的动作来源）。
 *   · `progressing`  —— 在推进，**不打扰**。
 *   · `passive-wait` —— 在等一件**有上限**的事（sleep 到点 / 有界超时的网络请求），**不打扰**。
 *   · `unknown`      —— 信息不足，不下结论（交给 L2 模型，或干脆再采一次）。
 *
 * ── 反直觉的两条（都来自实测，别「优化」掉）──
 *   ① **无超时上限的网络命令 = stuck**，哪怕「看起来正在传」。`curl` / `git fetch` / `ssh` 默认**没有**总超时，
 *      DNS/TLS 半死时是**永久**挂起 —— 模型会以为「默认超时会自己失败」。这条是历史上 1849 条 `nohup` 绕开的成因。
 *   ② **静默倍数才是判据，绝对时长不是**。`npm i` 静默 60s 正常，`ls` 静默 60s 是死了 —— 同一把尺子是
 *      `静默时长 / 该命令历史 p50`；没有 p50 时退回绝对下限（`stallFloorMs`）并降置信度。
 */

/** 采集到的进程现场（L0 的产物；采样器 `main/services/process-sampler.ts` 负责填）。 */
export interface ProcessSample {
    /** 人类可读的完整命令（判据要看 `--max-time` 这类参数）。 */
    readonly command: string;
    /** 已运行（ms）。 */
    readonly runMs: number;
    /** 累计输出字节。 */
    readonly outputBytes: number;
    /** 距**最后一次**输出多久（ms）；从未输出过 = `runMs`。 */
    readonly silentMs: number;
    /** **root 进程**的瞬时 CPU 百分比（macOS `top -l 2` **第二块**取样；`-l 1` 第一块是生命周期累计值）。 */
    readonly cpuPercent: number;
    /**
     * **整棵进程树**（root + 全部后代）的 CPU 百分比聚合（`ps -axo pid=,ppid=,pcpu=` 求后代和）。
     *
     * 为什么必须有它：`npm run build` / `./sha.sh check` / `vitest` / `sha.sh build` 全是
     * **「父进程在等、子进程在算」** 的形状 —— 只看 root 会看到 CPU≈0 + 无输出，
     * 静默超阈值就直接判 `stuck`，一接上 L2 就会对着我们自己的构建任务狂唤醒。
     *
     * 缺省（老样本 / 回放数据无此字段）= 退回只看 `cpuPercent`。
     */
    readonly treeCpuPercent?: number;
    /** 直接子进程数（证据，进 reason / 日志；判据用的是 `treeCpuPercent`）。 */
    readonly childCount: number;
    /** TCP 连接（`lsof -nP -a -p <pid> -iTCP` 的产物）。 */
    readonly connections: readonly ConnectionInfo[];
    /** 该命令历史耗时中位数（ms）；没有历史 = null。 */
    readonly historicalP50Ms: number | null;
}

export interface ConnectionInfo {
    readonly remote: string;
    readonly state: string;
}

export type HealthVerdict = "stuck" | "progressing" | "passive-wait" | "unknown";

/** 命中的判据编号 —— 单测与日志按它归因，改判据必须改编号。 */
export type HealthRule =
    | "R1:output-growing"
    | "R2:cpu-active"
    | "R3:unbounded-network-wait"
    | "R4:stalled-vs-p50"
    | "R5:bounded-passive-wait"
    | "R6:insufficient-evidence";

export interface HealthDiagnosis {
    readonly verdict: HealthVerdict;
    readonly rule: HealthRule;
    /** 一句话理由（进唤醒消息，别让主模型再 tail 一遍）。 */
    readonly reason: string;
    /** 静默 / p50 的倍数；无 p50 = null。 */
    readonly stallFactor: number | null;
    /** 0..1。无 p50 支撑、仅靠绝对阈值的结论要打折。 */
    readonly confidence: number;
}

export interface HealthPolicy {
    /** 静默短于此时长 ⇒ 一律算在推进（短命令别误判）。 */
    readonly progressWindowMs: number;
    /** 静默 > `stallFactor × p50` ⇒ 疑似停滞。 */
    readonly stallFactor: number;
    /** 绝对静默下限：不到这个数不看倍数（`ls` 也要 60s 才可疑）。 */
    readonly stallFloorMs: number;
    /** CPU 高于此值 = 进程在算（不是单纯在等）。 */
    readonly cpuActivePercent: number;
    /** p50 下限，防「历史中位 3ms」把倍数放大成天文数字。 */
    readonly p50FloorMs: number;
}

export const DEFAULT_HEALTH_POLICY: HealthPolicy = {
    progressWindowMs: 15_000,
    stallFactor: 10,
    stallFloorMs: 60_000,
    cpuActivePercent: 5,
    p50FloorMs: 1_000,
};

/** 网络客户端判据：`bounded` = 该命令自己带总超时，会自己失败返回。 */
export interface NetworkWait {
    /** 是不是在等网络（命令是网络客户端）。 */
    readonly network: boolean;
    /** 有没有总超时上限。`network && !bounded` ⇒ 等下去就是永久。 */
    readonly bounded: boolean;
    /** 命中的客户端（证据：进 reason / 日志）。 */
    readonly client: string | null;
}

/** 带「总超时」参数的网络客户端：命中即 `bounded: true`。 */
const BOUNDED_FLAGS: readonly (readonly [RegExp, string])[] = [
    [/(?:^|\s)--max-time(?:=|\s+)\S+/, "curl --max-time"],
    [/(?:^|\s)-m\s*\d+/, "curl -m"],
    [/(?:^|\s)--connect-timeout(?:=|\s+)\S+/, "curl --connect-timeout"],
    [/(?:^|\s)--timeout(?:=|\s+)\S+/, "wget --timeout"],
    [/(?:^|\s)-o\s*ConnectTimeout=\S+/, "ssh ConnectTimeout"],
    [/(?:^|\s)--fetch-timeout(?:=|\s+)\S+/, "npm --fetch-timeout"],
    [/(?:^|\s)--timeout-ms(?:=|\s+)\S+/, "generic --timeout-ms"],
];

/** 默认**有**总超时的客户端（不进 `stuck` 判据）：它们的「默认超时」是真的会自己失败。 */
const SELF_BOUNDED_CLIENTS: readonly string[] = ["wget", "npm", "pnpm"];

/** 默认**没有**总超时的客户端：等下去就是永久（除非命令里显式给了超时）。 */
const UNBOUNDED_CLIENTS: readonly string[] = ["curl", "nc", "netcat", "telnet", "docker", "kubectl", "gh"];

const NETWORK_SUBCOMMANDS: Record<string, readonly string[]> = {
    git: ["fetch", "clone", "pull", "push", "ls-remote", "submodule", "remote"],
    ssh: [],
    scp: [],
    rsync: [],
};

function tokens(command: string): string[] {
    return command.trim().split(/\s+/).filter(Boolean);
}

const DURATION_RE = /^\d+(?:\.\d+)?[smhd]?$/;

/**
 * coreutils 的 `timeout <dur>` / `gtimeout <dur>` 包装器：`timeout 30 curl …`。
 * 返回「时长 + 之后的起始下标」，不是 timeout 包装器则 `limit = null`。
 * 选项里 `-s SIG` / `-k DUR` 各带一个参数，都要跳过去。
 */
function parseTimeoutWrapper(toks: readonly string[], start: number): { limit: string | null; next: number } {
    let i = start + 1;
    while (i < toks.length && toks[i].startsWith("-")) {
        const opt = toks[i];
        i++;
        if (opt === "-s" || opt === "--signal" || opt === "-k" || opt === "--kill-after") i++;
    }
    if (i < toks.length && DURATION_RE.test(toks[i])) return { limit: toks[i], next: i + 1 };
    return { limit: null, next: i };
}

/** 取 exec 用的首个有效词（跳过 `env FOO=bar` / `sudo` / `nohup` / `time` / `timeout 30` 这类前缀）。 */
function headWord(toks: readonly string[]): { head: string; rest: readonly string[]; timeoutLimit: string | null } {
    let i = 0;
    let timeoutLimit: string | null = null;
    while (i < toks.length) {
        const t = toks[i];
        if (t.includes("=") && !t.startsWith("-") && !t.startsWith("/")) {
            i++; // env 赋值
            continue;
        }
        if (t === "timeout" || t === "gtimeout") {
            const w = parseTimeoutWrapper(toks, i);
            timeoutLimit = w.limit;
            i = w.next;
            continue;
        }
        if (["sudo", "nohup", "env", "time", "command", "exec", "nice", "setsid", "caffeinate"].includes(t)) {
            i++;
            continue;
        }
        break;
    }
    return { head: (toks[i] ?? "").replace(/^.*\//, ""), rest: toks.slice(i + 1), timeoutLimit };
}

/**
 * 这个命令是不是「在等网络」，以及**有没有总超时上限**。
 * 判据只看命令本身（不看配置 / 系统参数）—— 拿不到就按默认语义走，宁可判 `stuck` 让人看一眼，也不默认它安全。
 */
export function probeNetworkWait(command: string): NetworkWait {
    const toks = tokens(command);
    const { head, rest, timeoutLimit } = headWord(toks);

    for (const [re, label] of BOUNDED_FLAGS) {
        if (re.test(command)) return { network: isNetworkClient(head, rest), bounded: true, client: label };
    }

    // `timeout 30 curl …`：包装器给了**总**超时 —— 后台进程到点会被杀掉，不会永久挂起。
    // 必须显式识别：否则 head 落到 `curl` 会走 UNBOUNDED_CLIENTS，把有界命令判成 `stuck`。
    if (timeoutLimit !== null && isNetworkClient(head, rest)) {
        return { network: true, bounded: true, client: `timeout ${timeoutLimit} ${head}` };
    }

    if (SELF_BOUNDED_CLIENTS.includes(head)) return { network: true, bounded: true, client: head };
    if (UNBOUNDED_CLIENTS.includes(head)) return { network: true, bounded: false, client: head };

    const subs = NETWORK_SUBCOMMANDS[head];
    if (subs) {
        // `git status` 不算；`git fetch` 算。ssh/scp/rsync 本身即网络。
        const hit = subs.length === 0 || subs.some((s) => rest.includes(s));
        return { network: hit, bounded: false, client: hit ? (subs.length === 0 ? head : `git ${rest[0] ?? ""}`) : null };
    }
    return { network: false, bounded: true, client: null };
}

function isNetworkClient(head: string, rest: readonly string[]): boolean {
    const subs = NETWORK_SUBCOMMANDS[head];
    if (subs) return subs.length === 0 || subs.some((s) => rest.includes(s));
    return UNBOUNDED_CLIENTS.includes(head) || SELF_BOUNDED_CLIENTS.includes(head) || head === "ssh" || head === "scp";
}

/** 有明确到点的等待（自身带时长，不需要人 / 网络推进）。 */
export function isTimedWait(command: string): boolean {
    const toks = tokens(command);
    const { head } = headWord(toks);
    if (head === "sleep" || head === "pg_sleep") return true;
    if (/^\d+(?:\.\d+)?[smh]?$/.test(toks[toks.length - 1] ?? "") && /\bsleep\s/.test(command)) return true;
    return false;
}

/**
 * 判活。顺序即优先级，**不要重排**：
 *   未静默够久（R1）→ 在算（R2）→ 无界网络等待（R3）→ 静默倍数（R4）→ 有界等待（R5）→ 证据不足（R6）。
 * 之所以把 R3 放在 R4 之前：无界网络等待不需要「静默很久」才成立 —— 它**永远不会自己结束**，
 * 而 R4 的倍数判据在有 p50 噪声时会漏。反过来 R3 必须放在 R1/R2 之后：刚起来还在传数据的不算。
 */
export function judgeHealth(sample: ProcessSample, policy: HealthPolicy = DEFAULT_HEALTH_POLICY): HealthDiagnosis {
    const p50 = sample.historicalP50Ms === null ? null : Math.max(sample.historicalP50Ms, policy.p50FloorMs);
    const stallFactor = p50 === null ? null : sample.silentMs / p50;
    const net = probeNetworkWait(sample.command);
    const stalledEnough = sample.silentMs >= policy.stallFloorMs;
    const overP50 = stallFactor !== null && stallFactor >= policy.stallFactor;
    // 进程树聚合优先：构建类命令是「父在等、子在算」，只看 root 必误判 stuck。
    const activeCpu = Math.max(sample.cpuPercent, sample.treeCpuPercent ?? 0);
    const idleCpu = activeCpu < policy.cpuActivePercent;

    if (sample.silentMs <= policy.progressWindowMs) {
        return {
            verdict: "progressing",
            rule: "R1:output-growing",
            reason: `${Math.round(sample.silentMs / 1000)}s 前还有输出`,
            stallFactor,
            confidence: 0.98,
        };
    }

    // CPU 在算就**一律**算推进 —— 即使静默已超倍数。
    // 理由：「父在等、子在算」（构建/编译/测试）是最常见的长时间无输出形态，若还要求「未超倍数」才认 CPU，
    // 等于把最需要放过的一类判死。代价是「CPU 高 + 零输出的 busy loop」也会落在这里（已知边界，交 L2 判语义）。
    if (!idleCpu) {
        return {
            verdict: "progressing",
            rule: "R2:cpu-active",
            reason: `CPU ${activeCpu.toFixed(1)}%（进程树聚合）仍在算`,
            stallFactor,
            confidence: 0.9,
        };
    }

    if (net.network && !net.bounded && (stalledEnough || sample.connections.length > 0)) {
        const remote = sample.connections[0]?.remote ?? "无活动连接";
        return {
            verdict: "stuck",
            rule: "R3:unbounded-network-wait",
            reason: `${net.client ?? "网络客户端"} 无总超时上限（${remote}），不会自己失败返回`,
            stallFactor,
            confidence: p50 === null ? 0.6 : 0.8,
        };
    }

    if (sample.connections.length > 0 && net.bounded && stalledEnough && overP50) {
        return {
            verdict: "passive-wait",
            rule: "R5:bounded-passive-wait",
            reason: `等网络但自带超时（${net.client ?? "有界"}），会自己失败返回`,
            stallFactor,
            confidence: 0.6,
        };
    }

    if (isTimedWait(sample.command)) {
        return {
            verdict: "passive-wait",
            rule: "R5:bounded-passive-wait",
            reason: "sleep 到点自己会醒",
            stallFactor,
            confidence: 0.9,
        };
    }

    if (stalledEnough && overP50 && idleCpu) {
        return {
            verdict: "stuck",
            rule: "R4:stalled-vs-p50",
            reason: `静默 ${Math.round(sample.silentMs / 1000)}s = 历史中位的 ${stallFactor?.toFixed(0)}×，CPU ${activeCpu.toFixed(1)}%（${sample.childCount} 个子进程）`,
            stallFactor,
            confidence: p50 === null ? 0.55 : 0.75,
        };
    }

    return {
        verdict: "unknown",
        rule: "R6:insufficient-evidence",
        reason: p50 === null ? "无历史耗时，且未超绝对静默下限" : `静默 ${stallFactor?.toFixed(1)}× 中位，未达阈值`,
        stallFactor,
        confidence: 0.3,
    };
}

/** 一批历史耗时（ms）→ 中位数；不足 3 条视为「没有历史」（噪声太大）。 */
export function medianDuration(samples: readonly number[]): number | null {
    if (samples.length < 3) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
