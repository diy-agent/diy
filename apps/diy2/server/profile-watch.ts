// profile-watch.ts —— 卡顿归因：把「卡的那一段」的 CPU profile 留下来。
//
// 背景（2026-11-28）：`loop-lag` 能报「卡了 78 秒」，但只在卡顿**结束后**才醒，
// 醒来时热栈已经没了；`timed` 又只覆盖被包住的少数几处。于是日志能证明「卡了」，
// 却答不出「谁卡的」。
//
// 做法：进程启动就开一个**低采样**的 Inspector profiler（默认 1ms 一次，约 1~3% CPU），
// 每 `rotateMs`（默认 30s）停一次：
//   · 这段里有人 `markLag()` 过 → 把 profile 落 `<dir>/cpu-<本地时间>.cpuprofile`
//   · 没人报卡 → 直接丢弃，不产生磁盘垃圾
// 然后立刻重新开始采样，profile 不会无限长。`markLag` 由 `loop-lag` 的 `onLag` 喂进来，
// 所以文件里覆盖的正好是卡顿发生的那一段。`.cpuprofile` 用 Chrome DevTools
// Performance 面板的「Load profile」直接打开。
//
// 只在自己吃 CPU 时才有意义：被系统饿死（cpuRatio≈0）时 profile 里只会是空闲/GC，
// 那种情况看 `load1` / `ncpu` 就行 —— 判词已经在 `loop-lag` 的日志行里。
//
// 关掉：`DIY2_CPU_PROFILE=0`（采样器本身是旁路，任何失败都只记一行日志，不影响服务）。

import { mkdir, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector';
import { join } from 'node:path';

/** `Profiler.stop()` 回包里我们唯一用到的字段（不依赖 inspector 的类型命名空间） */
interface InspectorProfile {
    samples?: number[];
    [key: string]: unknown;
}

export interface CpuProfileWatchOptions {
    /** 落盘目录（装配层给 `<home>/log/profile`，与其余运行产物同根） */
    dir: string;
    /** 每隔多久停一次采样（默认 30s）；卡顿过才写，没卡直接丢 */
    rotateMs?: number;
    /** Inspector 采样间隔（微秒，默认 1000） */
    samplingIntervalUs?: number;
    /** 日志出口（默认静默；装配层接到 appLog，失败才说话） */
    log?: (line: string) => void;
    /** 时钟（测试注入） */
    now?: () => number;
    /** 写文件（测试注入；默认 fs.writeFile） */
    writeFile?: (path: string, data: string) => Promise<void>;
}

export interface CpuProfileWatch {
    /**
     * loop-lag 每次超阈值卡顿时调它（只记最大的一笔，轮转时统一落盘）。
     *
     * `cpuRatio`（0~1）低于阈值时不落盘：那说明本进程整段时间没在算（被系统饿死），
     * profile 里只会是空闲栈，留着只是几 MB 垃圾。缺省按「自己在算」处理。
     */
    markLag(lagMs: number, cpuRatio?: number): void;
    /** 停止采样并做最后一次落盘（关进程 / 重建前调） */
    stop(): Promise<void>;
}

type Post = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

function sessionPost(session: Session): Post {
    return (method, params) =>
        new Promise((resolve, reject) => {
            session.post(method, params ?? {}, (error, result) => {
                if (error !== null) reject(error);
                else resolve(result as never);
            });
        });
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * 文件名里不能有冒号（跨平台），本地时间 + 偏移仍保留：`2026-11-28T11-30-00.123+0800`。
 *
 * 不引 `@diy-agent/time`：`apps/*` 的依赖一律走构建产物 dist，而单测 / dev 里
 * 跨包 realpath 解析会被 Vite 的 fs.allow 拦（已实测 2026-11-28）。格式本身只有 6 行。
 */
export function profileStamp(at: number): string {
    const d = new Date(at);
    const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const time = `${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    // getTimezoneOffset() 是「UTC - 本地」的分钟数（东八区 = -480），符号要反过来
    const offsetMin = -d.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    return `${date}T${time}${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`;
}

export function startCpuProfileWatch(options: CpuProfileWatchOptions): CpuProfileWatch {
    const rotateMs = options.rotateMs ?? 30_000;
    const samplingIntervalUs = options.samplingIntervalUs ?? 1000;
    const log = options.log ?? ((): void => undefined);
    const now = options.now ?? Date.now;
    const write = options.writeFile ?? ((path, data) => writeFile(path, data, 'utf8'));

    const session = new Session();
    session.connect();
    const post = sessionPost(session);

    let ready = false;
    /** profiler 当前是否在采（stop 之后不能再 stop 一次，否则会把错误刷进日志） */
    let running = false;
    let stopped = false;
    let inflight: Promise<void> = Promise.resolve();
    let queued = false;
    let startedAt = now();
    /** 这一窗口里最大的一笔卡顿（含被饿死的那种，用于日志） */
    let pendingLag = 0;
    let pendingCpuRatio = 1;
    /**
     * 这一窗口里「自己在算」的最大一笔卡顿。
     *
     * 不能只看 `pendingLag` 的 cpuRatio：机器忙时后面一笔更长的「被饿死」卡顿
     * （cpuRatio 20~30%）会把前面 800ms 的 CPU 热栈覆盖掉 → 永远不落 profile。
     * 实测 2026-11-28 lab：874ms / 59% 被随后 1503ms / 31% 盖掉，一条 profile 都没出。
     */
    let profileLag = 0;

    inflight = (async (): Promise<void> => {
        try {
            await post('Profiler.enable');
            await post('Profiler.setSamplingInterval', { interval: samplingIntervalUs });
            await post('Profiler.start');
            ready = true;
            running = true;
            startedAt = now();
        } catch (error) {
            log(`[diy2:profile] 采样器启动失败（卡顿将没有 profile）：${String(error)}`);
        }
    })();

    async function persist(profile: InspectorProfile, lagMs: number, windowMs: number): Promise<void> {
        try {
            await mkdir(options.dir, { recursive: true });
            const file = join(options.dir, `cpu-${profileStamp(now())}.cpuprofile`);
            await write(file, JSON.stringify(profile));
            const samples = profile.samples?.length ?? 0;
            log(
                `[diy2:profile] 已保存卡顿期间的 CPU profile：${file}` +
                    `（lag=${Math.round(lagMs)}ms window=${Math.round(windowMs)}ms samples=${samples}）`,
            );
        } catch (error) {
            log(`[diy2:profile] profile 落盘失败：${String(error)}`);
        }
    }

    /** 停掉当前这段；卡顿过就落盘，然后重新开始（除非已经 stop） */
    async function rotate(): Promise<void> {
        if (!ready || !running) return;
        const lag = pendingLag;
        const cpuRatio = pendingCpuRatio;
        const ownLag = profileLag;
        const windowMs = now() - startedAt;
        pendingLag = 0;
        pendingCpuRatio = 1;
        profileLag = 0;
        startedAt = now();
        try {
            const { profile } = await post<{ profile: InspectorProfile }>('Profiler.stop');
            running = false;
            if (ownLag > 0) await persist(profile, ownLag, windowMs);
            else if (lag > 0) {
                log(
                    `[diy2:profile] lag=${Math.round(lag)}ms 期间 cpuRatio=${(cpuRatio * 100).toFixed(0)}%` +
                        ' —— 本进程没在算（被系统饿死 / 等 IO），不写 profile；看 load1',
                );
            }
            if (!stopped) {
                await post('Profiler.start');
                running = true;
                startedAt = now();
            }
        } catch (error) {
            log(`[diy2:profile] 采样轮转失败：${String(error)}`);
        }
    }

    function kick(): void {
        if (queued) return;
        queued = true;
        inflight = inflight.then(() => {
            queued = false;
            return rotate();
        });
    }

    const timer = setInterval(kick, rotateMs);
    timer.unref?.();

    return {
        markLag: (lagMs, cpuRatio = 1) => {
            if (lagMs > pendingLag) {
                pendingLag = lagMs;
                pendingCpuRatio = cpuRatio;
            }
            // 「自己在算」的那一类单独留一笔，别被后续更长的饥饿卡顿盖掉
            if (cpuRatio >= 0.5 && lagMs > profileLag) profileLag = lagMs;
        },
        stop: async () => {
            if (stopped) {
                await inflight;
                return;
            }
            stopped = true;
            clearInterval(timer);
            // rotate 会在 stopped 之后跳过 restart，最后一次落盘仍走同一条路
            inflight = inflight.then(() => rotate()).catch(() => undefined);
            await inflight;
            try {
                session.disconnect();
            } catch {
                // 已经断开 / 进程正在退出：没什么可做的
            }
        },
    };
}
