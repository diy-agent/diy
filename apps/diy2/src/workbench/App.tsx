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
    BotsOverlay,
    needsYou,
    RoomDialogsProvider,
    Sidebar,
    useBotRows,
    useLoaded,
    useModelSetup,
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
import { BotGlyph, GearGlyph, NavGlyph } from './glyphs';
import { type PageDef } from './model';
import { pageFor, settingsPage, wbViews } from './pages';
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
            // 两个入口挨着、却各管一摊（一个管导航宽度、一个管它显不显），只会让人分不清
            showToggle={false}
            onCreateProject={dialogs.openProject}
            onCreateTask={dialogs.openTask}
            onRequestDelete={dialogs.requestDelete}
            // `onOpenSettings` **不传**：设置入口只在标题栏右端一处（原来侧栏底部还有
            // 一颗，两边做同一件事，留在左下角只会让人犹豫点哪个）
        />
    );
}

// ── 模型配置的横幅 ─────────────────────────────────────────────────

/**
 * 顶部横幅：这个实例的模型配置**不全**（没 model.yaml / 缺目录快照）。
 *
 * 为什么是横幅而不是拦住整页：没有 model.yaml 时服务端照样起（房间 / 会话 / 工具都正常），
 * 只有「发一轮」和「选模型」会失败 —— 把整页拦下反而让人看不到自己已有的房间。
 * 横幅只说三件事：缺什么、缺在哪、怎么补（全是可复制的路径 / 命令）。
 */
function ModelConfigBanner({ onConfigure }: { onConfigure?: () => void }) {
    const setup = useModelSetup();
    // 首屏之前 store 里是「正常」（见 store 的初始值）：没问过服务端就不指控
    if (setup.configured && !setup.snapshotMissing) return null;
    return (
        <div className="wb-banner" role="status">
            <span className="wb-banner-title">模型配置不全</span>
            {setup.configured ? null : (
                <span>
                    没有 model.yaml（<code>{setup.modelConfigPath}</code>）—— 不会去别处找
                </span>
            )}
            {setup.snapshotMissing ? (
                <span>
                    缺目录快照 <code>data/models.dev.json</code>（标准 provider 全没有规格）
                </span>
            ) : null}
            <span className="wb-banner-hint">
                填充：仓库根跑 <code>./scripts/seed-run-home.sh &lt;数据根&gt;</code>
            </span>
            {onConfigure === undefined ? null : (
                <button className="wb-banner-action" onClick={onConfigure}>
                    去配置 →
                </button>
            )}
        </div>
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

    /**
     * 屏幕：对话 / 设置。**不是** `Room.type` 派生的页 —— 设置不属于任何房间。
     *
     * 为什么要有它：模型配置是「这个实例能不能开工」的前置，它必须在**没有房间**时也能进
     * （全新数据根、model.yaml 还没写）。所以这条状态提到页之上，与「看哪个房间」正交。
     */
    const [screen, setScreen] = useState<'chat' | 'settings'>('chat');

    // 导航的开关提到了壳这一层：标题栏左端要放它的按钮，而标题栏是整宽的一条
    const [open, setOpen] = useState(loadNavOpen);

    // Bot 状态：标题栏那颗按钮的角标要计数，所以拉数据提到壳这一层，
    // 浮层与按钮共用一份（不各拉一次，否则两边的数字会差一轮）
    const [botsOpen, setBotsOpen] = useState(false);
    const bots = useBotRows(botsOpen);
    const attention = bots.rows.filter(needsYou).length;

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
                        id: 'bots',
                        label: attention === 0 ? 'Bot 状态' : `Bot 状态（${attention} 个要你看）`,
                        glyph: <BotGlyph count={attention} />,
                        onClick: () => {
                            setBotsOpen(true);
                        },
                    },
                    {
                        id: 'settings',
                        // 同一颗按钮来回切：设置页里它显示为按下态，再点一下回对话。
                        // 房内「模型设置」对话框（选模型）仍然在侧栏/房间头，两件事不冲突：
                        // 那个改的是**这个房间**用哪个模型，这里改的是**这个实例**有什么可用。
                        label: screen === 'settings' ? '返回对话' : '设置',
                        glyph: <GearGlyph />,
                        on: screen === 'settings',
                        onClick: () => {
                            setScreen((value) => (value === 'settings' ? 'chat' : 'settings'));
                        },
                    },
                ],
            },
        ],
        [open, toggle, dialogs, attention, screen],
    );

    // 设置页：**没有房间也能进**（这正是「没配置 → 去配置」那条路）
    if (screen === 'settings') {
        return (
            <RoomDialogsProvider value={dialogs}>
                <div className="wb-shell">
                    <ModelConfigBanner />
                    <PageShell
                        key={settingsPage.type}
                        page={settingsPage}
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

    // 没有房间时**也要**有导航：新建第一个房间的入口就在左栏，把它藏起来等于没法开工
    if (!room) {
        return (
            <RoomDialogsProvider value={dialogs}>
                <div className="wb-shell">
                    <ModelConfigBanner onConfigure={() => setScreen('settings')} />
                    <Window contributions={global} chrome={chrome} onChromeChange={setChrome} />
                    <div className="wb-body">
                        <NavRail nav={nav} />
                        <div className="wb-splash">
                            {loaded ? '还没有房间 —— 用左边的「新建」开一个' : '正在连接 diy2 …'}
                        </div>
                    </div>
                </div>
                {dialogs.element}
                {botsOpen ? <BotsOverlay {...bots} onClose={() => setBotsOpen(false)} /> : null}
            </RoomDialogsProvider>
        );
    }

    const page = pageFor(room.type);

    return (
        <RoomDialogsProvider value={dialogs}>
            <div className="wb-shell">
                <ModelConfigBanner onConfigure={() => setScreen('settings')} />
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
            {botsOpen ? <BotsOverlay {...bots} onClose={() => setBotsOpen(false)} /> : null}
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
