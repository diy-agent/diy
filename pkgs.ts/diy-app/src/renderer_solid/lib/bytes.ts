/**
 * 字节数 → 人类可读（1024 进制）。日志体积 / 记录大小 / 清理释放量的统一显示口径。
 *
 * 为什么单独成文件：流量页（列表「大小」列、头部日志体积）与清理面板（##324）都要它，
 * 放在组件里会形成「面板 import 页面组件」的反向依赖。
 */
export function fmtBytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0 B";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
        v /= 1024;
        i++;
    }
    return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
}
