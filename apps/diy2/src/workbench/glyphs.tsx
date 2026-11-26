// glyphs.tsx —— 纯图标：**只画几何，不认识任何业务**。
//
// 2026-11-25 起只剩两个：它们**没有 lucide 对应物**，所以继续自绘。
//   · `FarGlyph` —— 区域把手形态（收起时留一条边）
//   · `BotGlyph` —— 方头机器人 + 计数角标（lucide 的 bot 没有角标位）
//
// 其余已换成 lucide：区域按钮 → `PanelLeft/Right/Top/Bottom`（window.tsx）、
// 导航 → `Menu`、设置 → `Settings`（App.tsx）。当初自绘的理由是“几何块字形宽窄不一”，
// 而 `GearGlyph` 本来就是 lucide `settings` 的同一路径（2026-11-23 用户指定），换走无视觉变化。

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
