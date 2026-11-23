// App.tsx —— 工作台壳：**标题栏**（整宽，横跨导航）+ **全局层**（导航）+ **页层**（固定骨架）。
//
// 层级（2026-11-23 定）：标题栏指挥包括导航在内的所有区域，所以它在最外层、整宽；
// 导航是全局的 —— 它不属于任何一页，宽度与收起跨页类型共享。
// 页层才是「骨架固定 + area 内形态可配」的区域树。把导航塞进页模板会带来两个问题：
//   1. 切页类型时它跟着重排（任务页收起了、项目页又展开），用户会以为坏了；
//   2. Sidebar 自带宽度拖拽与按钮（localStorage `entity-chat:sidebar-width`），
//      与骨架里区域的尺寸（`workbench:<pageType>.sizes`）是两套真源 —— 它不属于任何一页。
//
// 两种收起方式的入口都**不靠标题栏才能存在**：`bar` 靠标题栏，`strip` 根本没画标题栏，
// 回切入口是页面右下角一个不占位的浮钮（`ChromeFab`）。
//
// 区域收起的两个入口，都不是「长在被收起的那个东西身上」（dockview 版就栽在这里）：
//   · bar   —— 页顶标题栏（`TitleBar`），它不在骨架里、还比导航更外层；
//   · strip —— 区域自己收成一条，条还在原地，点条展开。
// 两种随时切换（标题栏右端那个图标 / strip 模式下的右下角浮钮），共用同一份开合状态。

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
import { useEffect, useState } from 'react';

import '../index.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import '@astryxdesign/lab/lab.css';
import './workbench.css';

import { type NavState, TitleBar, usePageWorkbench, Workbench } from './AreaHost';
import { type PageDef } from './model';
import { pageFor, wbViews } from './pages';

// ── 全局层：导航 ───────────────────────────────────────────────────────────────

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
            onCreateProject={dialogs.openProject}
            onCreateTask={dialogs.openTask}
            onRequestDelete={dialogs.requestDelete}
            onOpenSettings={dialogs.openSettings}
        />
    );
}

// ── 页实例 ────────────────────────────────────────────────────────────────────

/** 一页 = 标题栏 + 导航 + 固定骨架。`key` 由外部按 page.type 给 —— 换页类型 = 换一份偏好 */
function PageShell({ page, nav }: { page: PageDef; nav: NavState }) {
    const api = usePageWorkbench(page, wbViews);
    return <Workbench api={api} views={wbViews} nav={nav} navRail={<NavRail nav={nav} />} />;
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

    const nav: NavState = {
        open,
        toggle: () => {
            setOpen((value) => !value);
        },
    };

    // 没有房间时**也要**有导航：新建第一个房间的入口就在左栏，把它藏起来等于没法开工
    if (!room) {
        return (
            <RoomDialogsProvider value={dialogs}>
                <div className="wb-shell">
                    <TitleBar nav={nav} />
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
                <PageShell key={page.type} page={page} nav={nav} />
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
