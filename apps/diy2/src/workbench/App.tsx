// App.tsx —— 工作台壳：**标题栏**（整宽，横跨导航）+ **全局层**（导航）+ **页层**（固定骨架）。
//
// 层级（2026-11-23 定）：标题栏指挥包括导航在内的所有区域，所以它在最外层、整宽；
// 导航是全局的 —— 它不属于任何一页，宽度与收起跨页类型共享。
// 页层才是「骨架固定 + area 内形态可配」的区域树。把导航塞进页模板会带来两个问题：
//   1. 切页类型时它跟着重排（任务页收起了、项目页又展开），用户会以为坏了；
//   2. Sidebar 自带宽度拖拽与按钮（localStorage `entity-chat:sidebar-width`），
//      与骨架里区域的尺寸（`workbench:<pageType>.sizes`）是两套真源 —— 它不属于任何一页。
//
// 标题栏（`window.tsx` 的 `Window`）**永远在**（两种把手形态下都在），是区域开合唯一的写入口。
// 它**不认识 page**：里面摆什么由「贡献」装配（本文件的全局按钮 + 页自己算的区域开关）：
//   · `bar`   —— 收起 = 不占位，只能从标题栏换回来；
//   · `strip` —— 收起 = 留一条，就地可点（单击展开 / 双击最大化）。
// 只换「收起来长什么样」，共用同一份开合状态 —— 所以随时可以切、状态不丢。
//
// 导航自己的收起按钮已停用（`showToggle={false}`）：标题栏左端那颗做的是同一件事。

import { LayerProvider } from '@astryxdesign/core/Layer';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import {
    RoomDialogsProvider,
    Sidebar,
    useLoaded,
    useRoomDialogs,
    useRoomDialogsContext,
    useSelectedRoom,
} from '@diy-agent/entity-chat';
import { useCallback, useEffect, useMemo, useState } from 'react';

import '../index.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import '@astryxdesign/lab/lab.css';
import './workbench.css';

import { usePageWorkbench, Workbench } from './AreaHost';
import { GearGlyph, NavGlyph } from './glyphs';
import { type PageDef } from './model';
import { pageFor, wbViews } from './pages';
import { useChrome, Window, type WindowContribution } from './window';

// ── 全局层：导航 ───────────────────────────────────────────────────────────────

/** 导航的开关（全局层持有）—— 标题栏上的那颗按钮由这里当贡献注册，window 不认识它 */
interface NavState {
    open: boolean;
    toggle: () => void;
}

const NAV_OPEN_KEY = 'workbench:nav-open';

/** 缺省展开：第一次进来总得看见房间列表 */
function loadNavOpen(): boolean {
    try {
        return localStorage.getItem(NAV_OPEN_KEY) !== '0';
    } catch {
        return true;
    }
}

/**
 * 导航（真侧栏：项目 / 任务 / 未归属 + 新建 / 设置）。
 *
 * `widthMode` 用缺省的 `own`：宽度与右缘手柄归 Sidebar 自己（键 `entity-chat:sidebar-width`），
 * 收起态是 56px 图标列。它**不参与**页层的骨架 —— 见文件头。
 */
function NavRail({ nav }: { nav: NavState }) {
    const dialogs = useRoomDialogsContext();

    return (
        <Sidebar
            open={nav.open}
            onToggle={nav.toggle}
            // 侧栏自己的收起按钮「退休」：标题栏左端那颗做同一件事，
            // 两个入口挨着、各管一丰，只会让人分不清
            showToggle={false}
            onCreateProject={dialogs.openProject}
            onCreateTask={dialogs.openTask}
            onRequestDelete={dialogs.requestDelete}
            // `onOpenSettings` **不传**：设置入口只在标题栏右端一处（原来侧栏底部还有
            // 一颗，两边做同一件事，留在左下角只会让人犹豫点哪个）
        />
    );
}

// ── 页实例 ────────────────────────────────────────────────────────────────────

/**
 * 一页 = 标题栏 + 导航 + 固定骨架。`key` 由外部按 page.type 给 —— 换页类型 = 换一份偏好。
 *
 * `global` / `chrome` 都由壳持有并向下一层传：标题栏的全局按钮不属于任何一页，
 * 收起形态又是**窗口**的偏好（跨页共享）。页只多贡献一件东西：这一页有哪些可收起的区域。
 */
function PageShell({
    page,
    nav,
    global,
    chrome,
    onChromeChange,
}: {
    page: PageDef;
    nav: NavState;
    global: readonly WindowContribution[];
    chrome: ReturnType<typeof useChrome>[0];
    onChromeChange: (chrome: ReturnType<typeof useChrome>[0]) => void;
}) {
    const api = usePageWorkbench(page, wbViews);
    return (
        <Workbench
            api={api}
            views={wbViews}
            navRail={<NavRail nav={nav} />}
            global={global}
            chrome={chrome}
            onChromeChange={onChromeChange}
        />
    );
}

function Host() {
    const room = useSelectedRoom();
    const loaded = useLoaded();
    const dialogs = useRoomDialogs();

    // 导航的开关提到了壳这一层：标题栏左端要放它的按钮，而标题栏是整宽的一条
    const [open, setOpen] = useState(loadNavOpen);

    useEffect(() => {
        try {
            localStorage.setItem(NAV_OPEN_KEY, open ? '1' : '0');
        } catch {
            /* 存储不可用：本次运行仍然生效，只是下次回到展开 */
        }
    }, [open]);

    const toggle = useCallback(() => {
        setOpen((value) => !value);
    }, []);
    const nav = useMemo<NavState>(() => ({ open, toggle }), [open, toggle]);

    // 收起后的样子是**窗口**的偏好（跨页共享）；hook 在 window 里，壳只把它往下传
    const [chrome, setChrome] = useChrome();

    // 全局层向标题栏**注册**的按钮：导航开关 + 设置。
    // 这两颗不属于任何一页，所以不该由页模板提供（那会让每页各写一份）。
    const global = useMemo<WindowContribution[]>(
        () => [
            {
                id: 'nav',
                leading: [
                    {
                        id: 'nav',
                        label: open ? '收起导航' : '展开导航',
                        glyph: <NavGlyph />,
                        on: open,
                        onClick: toggle,
                    },
                ],
            },
            {
                id: 'app',
                tools: [
                    {
                        id: 'settings',
                        label: '设置',
                        glyph: <GearGlyph />,
                        onClick: () => {
                            dialogs.openSettings();
                        },
                    },
                ],
            },
        ],
        [open, toggle, dialogs],
    );

    // 没有房间时**也要**有导航：新建第一个房间的入口就在左栏，把它藏起来等于没法开工
    if (!room) {
        return (
            <RoomDialogsProvider value={dialogs}>
                <div className="wb-shell">
                    <Window contributions={global} chrome={chrome} onChromeChange={setChrome} />
                    <div className="wb-body">
                        <NavRail nav={nav} />
                        <div className="wb-splash">
                            {loaded ? '还没有房间 —— 用左边的「新建」开一个' : '正在连接 diy2 …'}
                        </div>
                    </div>
                </div>
                {dialogs.element}
            </RoomDialogsProvider>
        );
    }

    const page = pageFor(room.type);

    return (
        <RoomDialogsProvider value={dialogs}>
            <div className="wb-shell">
                <PageShell
                    key={page.type}
                    page={page}
                    nav={nav}
                    global={global}
                    chrome={chrome}
                    onChromeChange={setChrome}
                />
            </div>
            {dialogs.element}
        </RoomDialogsProvider>
    );
}

/** 工作台 = 主题壳 + 标题栏 + 全局导航 + 一页区域树 */
export function WorkbenchApp() {
    return (
        <Theme theme={neutralTheme} mode="dark">
            <LayerProvider>
                <Host />
            </LayerProvider>
        </Theme>
    );
}
