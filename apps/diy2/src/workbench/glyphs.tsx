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

/** 设置：齿轮（圆 + 八辐） */
export function GearGlyph() {
    return (
        <svg className="wb-glyph" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
                <path d="M7 1.6v1.6M7 10.8v1.6M1.6 7h1.6M10.8 7h1.6M3.2 3.2l1.13 1.13M9.67 9.67l1.13 1.13M10.8 3.2L9.67 4.33M4.33 9.67L3.2 10.8" />
            </g>
        </svg>
    );
}
