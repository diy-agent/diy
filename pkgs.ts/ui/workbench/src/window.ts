// window.ts — 窗口落点策略：dev / test 实例一律开在**非主屏**（副屏 / Sidecar）。
//
// 为什么放在外壳：每个 app 都要「不遮挡用户正在干活的屏幕」这条规则，而各自抄一份
// mirrorWindowPos 迟早分叉（diy-app 里那份是同一个判据的来源）。外壳给出纯函数，
// 宿主只管把自己的 screen 传进来（单测不依赖 Electron）。
//
// 判据（与 diy-app 的 mirrorWindowPos 一致）：
//   · 目标 = 非主屏：优先 label 含 sidecar 的，其次第一个非主屏；单屏 ⇒ 不定位（空对象，走缺省）
//   · 尺寸恰好等于 workArea 会被 macOS 判为「出生即已 zoom」（##87）⇒ 高度内缩 ZOOM_INSET
//   · 宽度**不**内缩：掉到 Tailwind lg 断点（1024）以下会让侧栏布局失效（##297）

export interface WorkArea {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** screen.getAllDisplays() 的最小形状（只取定位要用的字段） */
export interface DisplayLike {
    readonly id: number;
    readonly label?: string;
    readonly workArea: WorkArea;
}

export const ZOOM_INSET = 48;
export const MIN_WINDOW_WIDTH = 480;
export const MIN_WINDOW_HEIGHT = 320;

/**
 * 副屏定位的窗口 options 子集（width/height/x/y）；找不到合适副屏 ⇒ 空对象。
 * 纯函数：显示器的数组由调用方给（Electron 的 screen 只在宿主里取）。
 */
export function sidecarWindowOptions(
    displays: readonly DisplayLike[],
    primaryId: number,
    width: number,
    height: number,
): Record<string, number> {
    const target =
        displays.find((d) => d.id !== primaryId && (d.label ?? "").toLowerCase().includes("sidecar")) ??
        displays.find((d) => d.id !== primaryId) ??
        null;
    if (!target) return {};
    const { x, y, width: w, height: h } = target.workArea;
    const fitW = Math.min(width, w);
    const fitH = Math.min(height, h);
    const winW = fitW;
    const winH = fitH === h ? Math.max(MIN_WINDOW_HEIGHT, h - ZOOM_INSET) : fitH;
    return {
        width: winW,
        height: winH,
        x: x + Math.max(0, Math.floor((w - winW) / 2)),
        y: y + Math.max(0, Math.floor((h - winH) / 2)),
    };
}
