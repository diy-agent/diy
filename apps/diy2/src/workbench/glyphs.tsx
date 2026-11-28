// glyphs.tsx —— 纯图标：**只画几何，不认识任何业务**。
//
// 2026-11-28（##43）起只剩 `FarGlyph` 一个 —— 它没有 lucide 对应物（一根竖边 + 一条
// 细条表达「收起时留一条」），所以继续自绘。
//
// 同日删掉 `BotGlyph`（方头机器人 + 计数角标）：它是 bot-overview 那颗按钮的图标，
// 那套 2026-11-25 已随建模决定（BotRole：bot 是类型级席位）移除，图标成了唯一残留 ——
// 留着只会让下一个人以为「原来还有一颗 Bot 按钮，是不是被谁关了」。另外它用
// `text-[9px]` 手搓角标，也不符合 DESIGN.md 的「禁任意值」。
//
// 其余图标都用 lucide：区域按钮 → `PanelLeft/Right/Top/Bottom`（window.tsx）、
// 导航 → `Menu`、设置 → `Settings`、Bot 活动 → `MessageSquare`、后台任务 → `SquareTerminal`。

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
