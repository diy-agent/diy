// window.tsx —— **窗口层**：一条标题栏 + 四边状态栏位置。只摆按钮，不认识任何业务。
//
// 依赖方向是**倒过来**的（这是这个文件存在的全部理由）：
//
//     App（全局：导航开关 / 设置）─┐
//                                 ├─→ 贡献 ─→ window（摆位置）
//     page（这一页有哪些区域可收）─┘
//
// 也就是说 window **不 import** page 模板、不认识 room / 视图 / WbApi ——
// 它只知道「这一项叫什么、落在哪一端、点它干什么」。区域是**页面**的概念
// （这一页有没有「资产」只有模板知道），状态栏是**窗口**的概念（跨页存在、切页不重排）。
// 让 window 反向 import page 就等于把两者焊死：加一页要改 window，插件也无处挂入口。
//
// 布局固定为三组，各组内的顺序 = **贡献注册顺序**：
//
//     [ 左端：leading 按钮 ]  [ 中间：文字 ]  [ 右端：区域按钮 │ tools │ 把手形态 ]
//
// **所有区域按钮都在右端**（2026-11-23 用户裁：分两端放「麻烦得很」）：左边只留应用级
// 入口（导航开关），区域一眼可数、不必到两端去找。方位（`side`）因此只剩一个用处 ——
// **画图标**（高亮块画在哪一边），不再决定按钮落在哪端。
// 区域按钮与工具按钮之间用竖线隔开：一个回答「页面怎么摆」，一个回答「应用能干什么」。

import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { PanelBottom, PanelLeft, PanelRight, PanelTop } from 'lucide-react';

import { FarGlyph } from './glyphs';
import { loadChrome, saveChrome, type Chrome, type Side } from './model';

/** 一份**区域贡献**：状态栏上的一个开关，控制某一页的某个区域收起 / 展开 */
export interface AreaContribution {
    /** 概念 id（与 page 模板里的一致，window 只用它做 key） */
    id: string;
    /** 名字：tooltip / aria-label 用 —— window 不画文字按钮 */
    title: string;
    /** 方位：**只用来画图标**（高亮块画在哪一边）；按钮一律落右端 */
    side: Side;
    open: boolean;
    onToggle: () => void;
}

/** 一颗工具按钮（图标 + tooltip） */
export interface ButtonContribution {
    id: string;
    label: string;
    glyph: ReactNode;
    /** 有 `on` 才是开关（按 pressed 渲染）；缺省 = 中性按钮 */
    on?: boolean;
    /**
     * 自带交互语义的 glyph（如含弹出列表的活动按钮），不再套一层 button。
     *
     * 这种 glyph 要自己保证外观与同排按钮一致（尺寸 / hover / 颜色），
     * 并且点击事件也在自己身上 —— 所以 `onClick` 对它没有意义。
     */
    standalone?: boolean;
    /** 缺省 = 纯展示（只有 standalone 才允许省） */
    onClick?: () => void;
}

/**
 * **一份贡献** = 一个注册者往窗口里放的东西。
 *
 * 全局壳注册一份（导航 / 设置…），页注册一份（这一页可收起的区域）。
 * window 不区分来源 —— 谁注册的、注册了几份，对它都一样：合并后按组摆开。
 */
export interface WindowContribution {
    /** 注册者 id（调试用，窗口不解释它） */
    id: string;
    /** 左端固定按钮 */
    leading?: readonly ButtonContribution[];
    /** 全局活动入口（会话 / 后台任务），显示在区域布局按钮左侧 */
    activity?: readonly ButtonContribution[];
    /** 区域开关 */
    areas?: readonly AreaContribution[];
    /** 右端工具按钮 */
    tools?: readonly ButtonContribution[];
    /** 中间的文字（面包屑）。多份贡献都有时按注册顺序并列 */
    title?: ReactNode;
}

/** 合并后的四组（渲染只认这个，不再看贡献边界） */
export interface WindowParts {
    leading: ButtonContribution[];
    activity: ButtonContribution[];
    areas: AreaContribution[];
    tools: ButtonContribution[];
    titles: ReactNode[];
}

/** 把多份贡献摊平成四组 —— 顺序 = 注册顺序，不做去重 / 不做排序 */
export function combineWindow(contributions: readonly WindowContribution[]): WindowParts {
    const parts: WindowParts = { leading: [], activity: [], areas: [], tools: [], titles: [] };
    for (const item of contributions) {
        if (item.leading !== undefined) parts.leading.push(...item.leading);
        if (item.activity !== undefined) parts.activity.push(...item.activity);
        if (item.areas !== undefined) parts.areas.push(...item.areas);
        if (item.tools !== undefined) parts.tools.push(...item.tools);
        if (item.title !== undefined && item.title !== null) parts.titles.push(item.title);
    }
    return parts;
}

/**
 * 把手形态（收起后「不占位」还是「留一条」）—— **窗口的偏好，不是页的**。
 *
 * 它跨页共享（切页类型不重置），也不属于任何区域的业务，所以状态住在这里；
 * 渲染骨架时由宿主当 prop 传下去。放在 page 的 `PageState` 里会变成
 * 「window 向 page 要自己的偏好」，方向反了。
 */
export function useChrome(storage: Storage = localStorage): [Chrome, (chrome: Chrome) => void] {
    const [chrome, setChrome] = useState<Chrome>(() => loadChrome(storage));
    useEffect(() => {
        saveChrome(chrome, storage);
    }, [chrome, storage]);
    return [chrome, setChrome];
}

// ── 渲染 ──────────────────────────────────────────────────────────────────────

/** 按钮：**只有图标**，文字全进 tooltip（标题栏是 28px 高的一条） */
function TbButton({ item, wide = false }: { item: ButtonContribution; wide?: boolean }) {
    if (item.standalone) return <>{item.glyph}</>;
    return (
        <button
            type="button"
            className={[
                'wb-tb-btn',
                // 活动入口带常显文字与数字，宽度得跟着内容走（不靠按钮 id 认，免得加一个漏一个）
                wide ? 'wb-tb-activity' : '',
                item.on === true ? 'on' : '',
            ]
                .filter(Boolean)
                .join(' ')}
            aria-pressed={item.on}
            title={item.label}
            aria-label={item.label}
            onClick={item.onClick}
        >
            {item.glyph}
        </button>
    );
}

/** 四个方位 → lucide 的 panel 系列（外框 + 该侧实心条，与原来的自绘图标同义） */
const AREA_GLYPH = { left: PanelLeft, right: PanelRight, top: PanelTop, bottom: PanelBottom } as const;

function TbArea({ item }: { item: AreaContribution }) {
    const Glyph = AREA_GLYPH[item.side];
    return (
        <TbButton
            item={{
                id: item.id,
                label: `${item.open ? '收起' : '展开'}「${item.title}」`,
                glyph: <Glyph className="wb-glyph" />,
                on: item.open,
                onClick: item.onToggle,
            }}
        />
    );
}

function Sep() {
    return <span className="wb-tb-sep" aria-hidden="true" />;
}

/**
 * 标题栏本体。
 *
 * `contributions` 是**唯一的输入面**：加一个按钮 = 多传一份贡献，不用改这里。
 * 它不跟自己以外的东西通信 —— 没有 context、没有 store、没有回调表。
 */
export function Window({
    contributions,
    chrome,
    onChromeChange,
}: {
    contributions: readonly WindowContribution[];
    chrome: Chrome;
    onChromeChange: (chrome: Chrome) => void;
}) {
    const parts = useMemo(() => combineWindow(contributions), [contributions]);

    // 没有可收起的区域时不给把手切换：那颗按钮此时改不动任何东西
    const toggleable = parts.areas.length > 0;
    const strip = chrome === 'strip';

    return (
        <header className="wb-titlebar">
            <div className="wb-tb-group">
                {parts.leading.map((item) => (
                    <TbButton key={item.id} item={item} />
                ))}
            </div>

            <div className="wb-tb-mid">
                {parts.titles.map((node, index) => (
                    <span key={index} className="wb-tb-name">
                        {index > 0 ? ' · ' : null}
                        {node}
                    </span>
                ))}
            </div>

            <div className="wb-tb-group wb-tb-group-end">
                {parts.activity.map((item) => (
                    <TbButton key={item.id} item={item} wide />
                ))}
                {parts.activity.length > 0 && (parts.areas.length > 0 || parts.tools.length > 0) ? <Sep /> : null}
                {parts.areas.map((item) => (
                    <TbArea key={item.id} item={item} />
                ))}
                {parts.areas.length > 0 && parts.tools.length > 0 ? <Sep /> : null}
                {parts.tools.map((item) => (
                    <TbButton key={item.id} item={item} />
                ))}
                {toggleable ? (
                    <>
                        {parts.areas.length > 0 || parts.tools.length > 0 ? <Sep /> : null}
                        <TbButton
                            item={{
                                id: 'chrome',
                                // 只换「收起的区域长什么样」：不占位 ↔ 留一条。
                                // 标题栏本身不参与切换 —— 它永远在，是唯一的恢复入口
                                label: strip ? '收起时改成不占位（现在留一条）' : '收起时改成留一条（现在不占位）',
                                glyph: <FarGlyph />,
                                on: strip,
                                onClick: () => {
                                    onChromeChange(strip ? 'bar' : 'strip');
                                },
                            }}
                        />
                    </>
                ) : null}
            </div>
        </header>
    );
}
