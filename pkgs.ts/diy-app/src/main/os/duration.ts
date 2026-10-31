// 🎯 时长文本的纯工具（OS 无关）
//
// `[[dd-]hh:]mm:ss` 是 POSIX `ps -o etime` 的格式，但**格式本身**不带平台假设：
// Windows 策略也用它把「创建时刻 → 已运行时长」渲染成同一个形状，
// 于是共享进程健康判据（shared/process-health.ts）两边吃到的是同一种数据。

/** `[[dd-]hh:]mm:ss` → ms。认不出 = null。 */
export function parseEtime(text: string): number | null {
    const raw = text.trim();
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(raw);
    if (!m) return null;
    const [, d, h, mi, s] = m;
    const days = d ? Number(d) : 0;
    const hours = h ? Number(h) : 0;
    return ((days * 24 + hours) * 60 + Number(mi)) * 60_000 + Number(s) * 1000;
}

/** ms → `[[dd-]hh:]mm:ss`（与 `parseEtime` 互逆；负数按 0 处理）。 */
export function formatEtime(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(total / 86_400);
    const hours = Math.floor((total % 86_400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const p2 = (n: number): string => String(n).padStart(2, "0");
    const clock = `${p2(minutes)}:${p2(seconds)}`;
    if (days > 0) return `${days}-${p2(hours)}:${clock}`;
    if (hours > 0) return `${p2(hours)}:${clock}`;
    return clock;
}
