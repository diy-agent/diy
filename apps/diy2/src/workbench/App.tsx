// App.tsx —— 工作台壳：**全局层**（导航）+ **页层**（固定骨架）+ 页外控制面。
//
// 两层模型（2026-11-23 定）：导航是全局的 —— 它不属于任何一页，宽度与收起跨页类型共享。
// 页层才是「骨架固定 + area 内形态可配」的区域树。把导航塞进页模板会带来两个问题：
//   1. 切页类型时它跟着重排（任务页收起了、项目页又展开），用户会以为坏了；
//   2. Sidebar 自带宽度拖拽与按钮（localStorage `entity-chat:sidebar-width`），
//      与「区域尺寸写死」是两套真源。
//
// 页外控制面（区域开关）放在布局**外面**：区域收起之后，区域里的按钮跟着一起不见，
// 恢复入口不能住在布局里。

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

import { usePageWorkbench, Workbench, type WbApi } from './AreaHost';
import { areasOf, type PageDef } from './model';
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
function NavRail() {
    const dialogs = useRoomDialogsContext();
    const [open, setOpen] = useState(loadNavOpen);

    useEffect(() => {
        try {
            localStorage.setItem(NAV_OPEN_KEY, open ? '1' : '0');
        } catch {
            /* 存储不可用：本次运行仍然生效，只是下次回到展开 */
        }
    }, [open]);

    return (
        <Sidebar
            open={open}
            onToggle={() => {
                setOpen((value) => !value);
            }}
            onCreateProject={dialogs.openProject}
            onCreateTask={dialogs.openTask}
            onRequestDelete={dialogs.requestDelete}
            onOpenSettings={dialogs.openSettings}
        />
    );
}

// ── 页外控制面：区域开关 ───────────────────────────────────────────────────────

/**
 * 只列**当前页模板里**的区域 —— 项目页没有 assets，列它就是个死键。
 * 视图数为 0 的区域不给按（这个页没东西放进去）。
 */
function AreaBar({ api }: { api: WbApi }) {
    const defs = areasOf(api.page.layout);
    return (
        <div className="wb-bar" role="group" aria-label="区域开关">
            <span className="wb-bar-label">{api.page.title}</span>
            {defs.map((def) => {
                const count = api.viewCountOf(def.id);
                const open = api.isOpen(def.id);
                return (
                    <button
                        key={def.id}
                        type="button"
                        className={open ? 'on' : undefined}
                        disabled={count === 0}
                        title={
                            count === 0
                                ? `${def.title}：这个页没有内容放进来`
                                : `${def.title}（${String(count)} 个视图）—— ${open ? '收起' : '展开'}`
                        }
                        onClick={() => {
                            api.toggleArea(def.id);
                        }}
                    >
                        {def.title}
                        {count > 1 && <span className="wb-badge">{String(count)}</span>}
                    </button>
                );
            })}
        </div>
    );
}

// ── 页实例 ────────────────────────────────────────────────────────────────────

/** 一页 = 固定骨架 + 区域内可配形态。`key` 由外部按 page.type 给 —— 换页类型 = 换一份偏好 */
function PageShell({ page, onApi }: { page: PageDef; onApi: (api: WbApi) => void }) {
    const api = usePageWorkbench(page, wbViews);
    useEffect(() => {
        onApi(api);
    }, [api, onApi]);
    return <Workbench api={api} views={wbViews} />;
}

function Host() {
    const room = useSelectedRoom();
    const loaded = useLoaded();
    const dialogs = useRoomDialogs();
    const [api, setApi] = useState<WbApi | null>(null);

    // 没有房间时**也要**有导航：新建第一个房间的入口就在左栏，把它藏起来等于没法开工
    if (!room) {
        return (
            <RoomDialogsProvider value={dialogs}>
                <div className="wb-shell">
                    <NavRail />
                    <div className="wb-splash">
                        {loaded ? '还没有房间 —— 用左边的「新建」开一个' : '正在连接 diy2 …'}
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
                <NavRail />
                <PageShell key={page.type} page={page} onApi={setApi} />
            </div>
            {api !== null && <AreaBar api={api} />}
            {dialogs.element}
        </RoomDialogsProvider>
    );
}

/** 工作台 = 主题壳 + 全局导航 + 一页区域树 + 页外控制面 */
export function WorkbenchApp() {
    return (
        <Theme theme={neutralTheme} mode="dark">
            <LayerProvider>
                <Host />
            </LayerProvider>
        </Theme>
    );
}
