// App.tsx —— 原型壳：主题 + 页外控制面 + 一页实例。
//
// 与 dockview 版最值得对照的一处：这套模型**没有 onApiReady 之后才能画开关**的时序问题，
// 但同样把「区域开关」放在布局外面 —— 理由不变：布局里的按钮跟着区域一起消失。

import { LayerProvider } from '@astryxdesign/core/Layer';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import {
    RoomDialogsProvider,
    useBots,
    useLoaded,
    useRoomDialogs,
    useSelectedRoom,
    roomTitle,
} from '@diy-agent/entity-chat';
import { useEffect, useState } from 'react';

import '../index.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import '@astryxdesign/lab/lab.css';
import './wb2.css';

import { usePageWorkbench, Workbench, type WbApi } from './AreaHost';
import { areasOf, viewsOfPage, type PageDef } from './model';
import { pageFor, wbViews } from './views';

/**
 * 页外控制面：**每个区域一个开关**。
 *
 * 注意它显示的是「这个页有哪些区域」—— 模板里没有的区域不会出现（项目页没有 detail），
 * 而不是「所有可能的区域」（那样切页就会有死键）。
 */
function AreaBar({ api, skeleton, onToggleSkeleton }: { api: WbApi; skeleton: boolean; onToggleSkeleton: () => void }) {
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
                                ? `${def.id}：这个页没有内容放进来`
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
            <button type="button" className={skeleton ? 'on' : undefined} onClick={onToggleSkeleton}>
                骨架
            </button>
        </div>
    );
}

/** 一页实例。key 由外部按 page.type 给 —— 换页类型 = 换一份偏好 */
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
    const bots = useBots();
    const dialogs = useRoomDialogs();
    const [api, setApi] = useState<WbApi | null>(null);
    const [skeleton, setSkeleton] = useState(false);

    if (!room) {
        return <div className="wb-splash">{loaded ? '还没有房间 —— 先去建一个' : '正在连接 diy2 …'}</div>;
    }

    const page = pageFor(room.type);
    const total = viewsOfPage(wbViews, page.type).length;

    return (
        <>
            <RoomDialogsProvider value={dialogs}>
                <div className={skeleton ? 'wb-shell wb-skeleton' : 'wb-shell'}>
                    <PageShell key={page.type} page={page} onApi={setApi} />
                </div>
            </RoomDialogsProvider>
            {api !== null && <AreaBar api={api} skeleton={skeleton} onToggleSkeleton={() => setSkeleton((v) => !v)} />}
            <div className="wb-foot">
                <span>
                    {roomTitle(room, bots)} · {room.id}
                </span>
                <span>
                    {page.type} 页 · {String(areasOf(page.layout).length)} 区 · {String(total)} 视图
                </span>
                <span className="wb-dim">
                    骨架固定：区域不能拖、不能分。视图不能关、不能搬。唯一能做的是收起区域、换区域内的摆法。
                </span>
            </div>
            {dialogs.element}
        </>
    );
}

export function Wb2App() {
    return (
        <Theme theme={neutralTheme} mode="dark">
            <LayerProvider>
                <Host />
            </LayerProvider>
        </Theme>
    );
}
