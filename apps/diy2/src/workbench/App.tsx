// App.tsx —— 工作台壳：**标题栏**（整宽，横跨导航）+ **全局层**（导航）+ **页层**（固定骨架）。
//
// 层级（2026-11-23 定）：标题栏指挥包括导航在内的所有区域，所以它在最外层、整宽；
// 导航是全局的 —— 它不属于任何一页，宽度与收起跨页类型共享。
// 页层才是「骨架固定 + area 内形态可配」的区域树。把导航塞进页模板会带来两个问题：
//   1. 切页类型时它跟着重排（任务页收起了、项目页又展开），用户会以为坏了；
//   2. Sidebar 自带宽度拖拽与按钮（localStorage `entity-chat:sidebar-width`），
//      与骨架里区域的尺寸（`workbench:<pageType>.sizes`）是两套真源 —— 它不属于任何一页。
//
// 标题栏**永远在**（两种把手形态下都在），是区域开合唯一的写入口：
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
            // 侧栏自己的收起按钮「退休」：标题栏左端那颗做同一件事，
            // 两个入口挨着、各管一丰，只会让人分不清
            showToggle={false}
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
