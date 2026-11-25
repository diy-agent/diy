// glyphs.tsx —— 纯图标：**只画几何，不认识任何业务**。
//
// 单独一个文件是因为它们有三个使用者，谁都不该把别人的图标定义抄一份：
//   · `window.tsx`  → AreaGlyph（区域按钮）/ FarGlyph（把手形态）
//   · `App.tsx`     → NavGlyph（导航）/ GearGlyph（设置）
//
// 全用 SVG 而不靠字符：几何块 U+25A4… 这类字形在不同字体里宽窄不一，
// 而标题栏是 28px 高的一条，差 1px 就会显得歪。

import type { Side } from './model';

/** 区域图标：外框 + **该方位上的高亮块**。只有四边有图标 —— center 不进标题栏 */
export function AreaGlyph({ side }: { side: Side }) {
    const inner =
        side === 'left'
            ? { x: 2, y: 2, width: 3.5, height: 10 }
            : side === 'right'
              ? { x: 8.5, y: 2, width: 3.5, height: 10 }
              : side === 'top'
                ? { x: 2, y: 2, width: 10, height: 3.5 }
                : { x: 2, y: 8.5, width: 10, height: 3.5 };
    return (
        <svg className="wb-glyph" viewBox="0 0 14 14" aria-hidden="true">
            <rect
                x="1.5"
                y="1.5"
                width="11"
                height="11"
                rx="2.5"
                fill="none"
                stroke="currentColor"
                strokeOpacity="0.45"
            />
            <rect {...inner} rx="1" fill="currentColor" />
        </svg>
    );
}

/** 把手形态：一根竖边 + 一条细条 —— “收起时留一条” */
export function FarGlyph() {
    return (
        <svg className="wb-glyph" viewBox="0 0 14 14" aria-hidden="true">
            <rect
                x="1.5"
                y="1.5"
                width="11"
                height="11"
                rx="2.5"
                fill="none"
                stroke="currentColor"
                strokeOpacity="0.45"
            />
            <rect x="2.2" y="2.2" width="1.8" height="9.6" rx="0.9" fill="currentColor" />
        </svg>
    );
}

/** 导航：三条横线（就是「列表」的意思） */
export function NavGlyph() {
    return (
        <svg className="wb-glyph" viewBox="0 0 14 14" aria-hidden="true">
            <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                <path d="M2.5 4h9M2.5 7h9M2.5 10h9" />
            </g>
        </svg>
    );
}

/** 设置：lucide `settings` 的同一枚齿轮 —— 与 entity-chat 侧栏原来那颗图标同一形状（2026-11-23 用户指定） */
export function GearGlyph() {
    return (
        <svg
            className="wb-glyph"
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
            <circle cx="12" cy="12" r="3" />
        </svg>
    );
}

/**
 * Bot 状态入口：方头 + 两点眼睛 + 一根天线 —— 「这些家伙在干什么」。
 *
 * 计数徽标画在右上角（`count` = 要你看的条数，0 时不画）：标题栏是 28px 的一条，
 * 数字只能靠角标，不能另起一列宽度。
 */
export function BotGlyph({ count }: { count: number }) {
    return (
        <span className="relative inline-flex">
            <svg className="wb-glyph" viewBox="0 0 14 14" aria-hidden="true">
                <rect
                    x="2"
                    y="4.4"
                    width="10"
                    height="7.4"
                    rx="2.4"
                    fill="none"
                    stroke="currentColor"
                    strokeOpacity="0.55"
                />
                <circle cx="5.3" cy="7.9" r="1.05" fill="currentColor" />
                <circle cx="8.7" cy="7.9" r="1.05" fill="currentColor" />
                <path d="M7 2.4v1.6" stroke="currentColor" strokeOpacity="0.55" strokeLinecap="round" />
            </svg>
            {count > 0 ? (
                <span className="absolute -right-1.5 -top-1 rounded-full bg-rose-500 px-1 text-[9px] leading-[12px] text-white">
                    {count > 99 ? '99+' : count}
                </span>
            ) : null}
        </span>
    );
}
