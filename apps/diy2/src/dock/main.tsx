// main.tsx —— 「工作台」页（`/dock.html`）：把 @diy-agent/workbench-dock 接到 diy2 的**真数据**上。
//
// 主入口 `src/main.tsx` 照旧直接渲染 `<EntityChatApp />`；这里是并行存在的第二块壳，
// 先在 lab 里跑通「区域树 + view 落位 + 布局持久化」，跑顺了再决定谁接谁 —— 不抢占主入口。
//
// 包与宿主的分工（见 workbench-dock/examples/02-pages）：
//   · 包只管**一个页**的布局（区域树、尺寸、收起、持久化）
//   · 「有哪些页实例」是宿主的事 —— 这里 = 一个房间一页（`room@room:task:xxx`）
//   · 「怎么切页」是宿主的事 —— 页实例 key 一变就是另一份布局，当前实例由 store 的地址决定
//   · 「弹窗挂在哪」也是宿主的事 —— `useRoomDialogs()` 在页外挂一次（和整页 App 同一套状态）

import { LayerProvider } from '@astryxdesign/core/Layer';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import {
    bootstrapStore,
    RoomDialogsProvider,
    useLoaded,
    useRoomDialogs,
    useSelectedRoom,
} from '@diy-agent/entity-chat';
import { pageId, type PageApi, type Scope } from '@diy-agent/workbench-dock';
import { PageWorkbench } from '@diy-agent/workbench-dock/react';
import { StrictMode, useMemo, useReducer, useState } from 'react';
import { createRoot } from 'react-dom/client';

// CSS 顺序与主入口一致：先 Tailwind（它 `@layer theme, base, components, utilities` 声明层顺序），
// 再 Astryx。dockview 的样式没有 @layer（全是 `.dv-*` 具体类），夹在中间不影响层顺序。
import '../index.css';
import 'dockview/dist/styles/dockview.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import '@astryxdesign/lab/lab.css';
import './dock.css';

import { roomPage, roomViews } from './page';

// store 的首屏加载由**页**触发（主入口是 App 里的 useEffect）：这里没有 <EntityChatApp />
// 先挂上，所以宿主自己点一次。幂等 —— 后面 App 再调也只是走同一条路。
// syncAddress: false —— 地址栏归 App 管（URL 即路由）；工作台是一页多区，store 一去
// replaceState 就变成 /room/xxx，刷新那次就落到主应用去了。
bootstrapStore({ syncAddress: false });

/** 模板里的四个区域，顺序与 `page.tsx` 的 area 声明一致（页外浮层照它排） */
const AREAS = ['left', 'center', 'right', 'bottom'] as const;

/**
 * 页外的区域开关。
 *
 * 为什么必须住在页外：`hideArea` 之后，那个区域里的按钮跟着一起看不见 —— **恢复入口
 * 不能住在布局里**，否则收起一次就再也打不开。所以 `PageWorkbench` 用 `onReady` 把
 * 区域控制面交出来，这条浮层画在它外面。
 *
 * `isAreaVisible` 不订阅状态（它只是问一次 dockview），所以点完自己 force 一次。
 */
function AreaBar({ api }: { api: PageApi }) {
    const [, force] = useReducer((n: number) => n + 1, 0);
    return (
        <div className="dock-areabar" role="group" aria-label="区域开关">
            {AREAS.map((id) => (
                <button
                    key={id}
                    type="button"
                    title={`显示 / 收起 ${id}`}
                    className={api.isAreaVisible(id) ? 'on' : undefined}
                    onClick={() => {
                        api.toggleArea(id);
                        force();
                    }}
                >
                    {id}
                </button>
            ))}
        </div>
    );
}

function WorkbenchHost() {
    const selected = useSelectedRoom();
    const loaded = useLoaded();
    // 弹窗与整页 App 共用一套：建项目 / 建任务 / 删房间 / 设置 / 换模型
    const dialogs = useRoomDialogs();
    /** 区域控制面（`onReady` 交出来，给页外的 AreaBar 用） */
    const [api, setApi] = useState<PageApi | null>(null);

    // 页实例身份 = (页类型, 房间 id)。只放**身份**，不放「展开的文件夹 / 当前筛选」这类会变的东西：
    // 那些一变页实例就换了，用户拖过的尺寸会被重编。
    const scope = useMemo<Scope | undefined>(
        () => (selected ? { kind: 'room', id: selected.id, title: selected.name } : undefined),
        [selected?.id, selected?.name],
    );

    if (!scope) {
        return <div className="dock-splash">{loaded ? '还没有房间 —— 先去主应用建一个' : '正在连接 diy2 …'}</div>;
    }

    return (
        <>
            {/* 左栏（真侧栏）要那五个动作（新建项目 / 建任务 / 删房间 / 设置），经 context 给它 */}
            <RoomDialogsProvider value={dialogs}>
                <PageWorkbench
                    // key 必须有：换房间 = 换组件实例 = 换一份独立布局（不带 key 是在同一实例上换 props，
                    // dockview 会试图合并两份布局，结果不是你想要的）
                    key={pageId(roomPage.type, scope)}
                    page={roomPage}
                    views={roomViews}
                    scope={scope}
                    storage={localStorage}
                    onApiReady={setApi}
                />
            </RoomDialogsProvider>
            {api !== null && <AreaBar api={api} />}
            {dialogs.element}
        </>
    );
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        {/* 和主入口同一套 provider：没它，对话框 / 弹出层没有层级上下文，暗色也拿不到 */}
        <Theme theme={neutralTheme} mode="dark">
            <LayerProvider>
                <div className="dock-root">
                    <WorkbenchHost />
                </div>
            </LayerProvider>
        </Theme>
    </StrictMode>,
);
