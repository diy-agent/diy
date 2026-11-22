// App.tsx —— 工作台页的壳：主入口 `/`（index.html → src/main.tsx）与 lab 页 `/dock.html` 共用。
//
// 包与宿主的分工（见 workbench-dock/examples/02-pages）：
//   · 包只管**一个页**的布局（区域树、尺寸、收起、持久化）
//   · 「有哪些页实例」是宿主的事 —— 这里 = 一个房间一页（`room@room:task:xxx`）
//   · 「怎么切页」是宿主的事 —— 页实例 key 一变就是另一份布局，当前实例由 store 的地址决定
//   · 「弹窗挂在哪」也是宿主的事 —— `useRoomDialogs()` 在页外挂一次（和整页 App 同一套状态）
//
// CSS 顺序与原来的主入口一致：先 Tailwind（它 `@layer theme, base, components, utilities`
// 声明层顺序），再 Astryx。dockview 的样式没有 @layer（全是 `.dv-*` 具体类），夹在中间不影响层顺序。

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
import { useMemo, useReducer, useState } from 'react';

import '../index.css';
import 'dockview/dist/styles/dockview.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import '@astryxdesign/lab/lab.css';
import './dock.css';

import { DOCK_AREAS, roomPage, roomViews } from './page';

// store 的首屏加载由**这一层**触发（整页 App 是在它的 useEffect 里）：工作台没有
// <EntityChatApp /> 负责这件事，所以宿主自己点一次。幂等 —— center 里的 App 再调也只是走同一条路。
// syncAddress: false —— 地址栏归页面路由管，工作台是一页多区：store 一去 replaceState
// 就变成 /room/xxx，刷新那次就落到别的壳里去了。
bootstrapStore({ syncAddress: false });

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
            {DOCK_AREAS.map((id) => (
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
        return <div className="dock-splash">{loaded ? '还没有房间 —— 先去建一个' : '正在连接 diy2 …'}</div>;
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

/** 工作台 = 主题壳 + 页外浮层 + 一个页实例 */
export function DockApp() {
    return (
        <Theme theme={neutralTheme} mode="dark">
            <LayerProvider>
                <div className="dock-root">
                    <WorkbenchHost />
                </div>
            </LayerProvider>
        </Theme>
    );
}
