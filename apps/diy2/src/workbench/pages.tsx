// pages.tsx —— 两个页模板 + 全部视图（**宿主侧装配**）。
//
// 这里只有**内容区**：导航不进模板 —— 它是全局层（跨页类型共享宽度与收起），住在
// App.tsx 的壳里。页模板回答的是「这一页除了导航还有什么、各自在哪、多大」。
//
// 区域一律用**概念 id** 声明（`conversation` / `detail` / `assets` / `diag`），`slot` 只说位置。
// 所以「把详情从左侧挪到右侧」= 改一个 `slot`，插在 `detail` 里的 view 一行都不用动。
//
// 两页的差别只有一处：任务页多一个「资产」区（这一轮聊出来的东西）。
// 这足够说明「骨架按页类型定」—— 同一个区域 id 在别的页里可能根本不存在（assets 在
// 项目页没有），所以折叠入口只能长在区域自己身上：不存在的区域没有条可收，也不该有开关。

import { EntityChatApp, TaskPanel, useSelectedRoom, type Room } from '@diy-agent/entity-chat';

import { useWb } from './AreaHost';
import { area, definePage, defineView, type PageDef } from './model';

// ── 页模板：位置写死，尺寸可拖 ───────────────────────────────────────────────────
//
// `modes: ['tab']` = 这个区域锁定标签页（不给切换按钮）；不写 = 三种形态都允许。
// **每个区域都有头**（单击收起 / 双击最大化都长在它身上），但单 view 的区域不给形态菜单
// —— 一个 tab 的「标签页 / 折叠 / 格子」长得一模一样，点了没反应的菜单只是噪音。
// 现在只有 diag 有多个 view，所以只有它会真的出现那颗 `⋯`。

/**
 * 中心 = 主区域：每页必备，名字是这一页围绕什么组织（这里是对话）。
 *
 * 写成函数而不是常量：两个页模板各自拿一份**独立对象** —— 区域定义是模板的真源，
 * 共享同一份会让「以后某页给 center 加个字段」悄悄改到另一页。
 */
const conversation = () => area('conversation', { slot: 'center', title: '对话', size: 'fr', min: 420 });

const taskPage = definePage({
    type: 'task',
    title: '任务',
    center: conversation(),
    // 三块附件：详情（左）/ 资产（右）/ 诊断（下）
    sides: [
        area('detail', { slot: 'left', title: '任务详情', size: 320, min: 240 }),
        area('assets', { slot: 'right', title: '资产', size: 320, min: 240, initial: 'collapsed' }),
        area('diag', { slot: 'bottom', title: '诊断', size: 200, min: 120, initial: 'collapsed' }),
    ],
});

export const projectPage = definePage({
    type: 'project',
    title: '项目',
    center: conversation(),
    // 项目页没有 assets：项目没有「这一轮聊出来的东西」这层
    sides: [
        area('detail', { slot: 'left', title: '项目信息', size: 320, min: 240 }),
        area('diag', { slot: 'bottom', title: '诊断', size: 200, min: 120, initial: 'collapsed' }),
    ],
});

/** 房间类型 → 页模板。**唯一一处**这个判断，别在别处再抄一份 */
export function pageFor(type: string): PageDef {
    return type === 'project' ? projectPage : taskPage;
}

// ── 视图 ────────────────────────────────────────────────────────────────────────

/** 对话：只留主区。导航 / 详情 / 资产各归自己的区域 —— 一个布局只该有一个真源 */
function ChatBody() {
    return (
        <div className="wb-chat">
            <EntityChatApp sidebar={false} taskPanel={false} />
        </div>
    );
}

/**
 * 任务详情。TaskPanel 自带 `w-[340px]`，在区域里换成 100%（见 workbench.css 的 `.wb-fill`）：
 * 固定宽度 + 区域固定宽度是两套真源，窄了溢出、宽了留白。
 *
 * **不传 `onClose`**：面板右上角自带一个 X，与区域的折叠按钮位置重叠且动作相同
 * （都是把这块收起来）。收起归布局管，内容不再自带第二个入口。
 */
function TaskDetail({ room }: { room: Room }) {
    return (
        <div className="wb-fill">
            <TaskPanel room={room} />
        </div>
    );
}

/** 项目信息：scope / 数据长什么样（也是「谁在读同一个 store」的验证） */
function ProjectInfo({ room }: { room: Room }) {
    const data = Object.entries(room.data ?? {});
    return (
        <div className="wb-info">
            <dl>
                <dt>id</dt>
                <dd>{room.id}</dd>
                <dt>type</dt>
                <dd>{room.type}</dd>
            </dl>
            <div className="wb-info-title">data</div>
            {data.length === 0 ? (
                <div className="wb-empty">（空）</div>
            ) : (
                <dl>
                    {data.map(([key, value]) => (
                        <div key={key} className="wb-info-row">
                            <dt>{key}</dt>
                            <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
                        </div>
                    ))}
                </dl>
            )}
        </div>
    );
}

/**
 * 详情区：任务页给真任务面板，其它页给信息卡。
 *
 * 判据用 `page.type`（页模板）而不是 `room.type` —— 页模板是 `pageFor` 算出来的，
 * 同一个房间将来可能被别的东西覆盖成另一页；两处各判一次迟早对不上。
 */
function DetailArea() {
    const api = useWb();
    const room = useSelectedRoom();
    if (!room) return <Empty>没有选中房间</Empty>;
    return api.page.type === 'task' ? <TaskDetail room={room} /> : <ProjectInfo room={room} />;
}

/**
 * 会话资产（**预留**）。
 *
 * agent 侧还没有「资产」这一层（工具产出全在会话流水里），所以现在只有空态。
 * 位置先定下来，等有了产出协议（写哪、怎么列）再填内容 —— 省得以后又挪一次骨架。
 */
function AssetsArea() {
    return (
        <div className="wb-info">
            <div className="wb-info-title">会话资产</div>
            <div className="wb-empty">（暂无）</div>
            <p className="wb-hint">
                这一栏留给<b>会话生成的资产文件</b>：代码片段、报告、截图、导出件… 数据源还没接 （agent
                侧尚无「资产」协议），位置先定。
            </p>
        </div>
    );
}

/** 诊断：这一页是谁、区域怎么开、偏好在哪 —— 排错时第一眼要看的东西 */
function DiagArea() {
    const api = useWb();
    const room = useSelectedRoom();
    return (
        <div className="wb-info">
            <dl className="wb-kv">
                <dt>页类型</dt>
                <dd>{api.page.type}</dd>
                <dt>房间</dt>
                <dd>{room?.id ?? '—'}</dd>
                <dt>偏好键</dt>
                <dd>
                    <code>workbench:{api.page.type}</code>
                </dd>
                <dt>骨架</dt>
                <dd>5 个固定槽位（center + 四边），见 src/workbench/pages.tsx</dd>
            </dl>
            <div className="wb-info-title">区域（概念 id @ 槽位）</div>
            <dl className="wb-kv">
                {api.page.areas.map((def) => (
                    <div key={def.id} className="wb-info-row">
                        <dt>
                            <code>{def.id}</code>
                            {def.slot === 'center' ? ' · 主区域' : ''}
                        </dt>
                        <dd>{def.slot}</dd>
                    </div>
                ))}
            </dl>
            <p className="wb-dim">
                区域的开合、形态、选中的 tab、拖过的尺寸存在上面那个键里；<b>位置</b>不在 —— 骨架在模板里写死。
            </p>
        </div>
    );
}

/** 说明：为什么骨架是固定的（这是模型本身，不是「还没做」） */
function GuideArea() {
    return (
        <div className="wb-info">
            <div className="wb-info-title">这套工作台的规则</div>
            <ul className="wb-rules">
                <li>
                    <b>骨架固定 5 个槽位</b>：center + 上下左右。不能拖换位置、不能分、不能浮动。
                    尺寸只能沿着槽位边界拖（双击复位）。
                </li>
                <li>
                    <b>center 就是主区域</b>：每页必备、永远展开、不参与收起 —— 收起它等于把这一页收没了。
                    四边放的都是它的附件。
                </li>
                <li>
                    <b>区域的身份是概念 id，不是方位</b>：插 view / 接插件一律按 id（<code>detail</code>、
                    <code>assets</code>…），不按 <code>left</code> 这样的位置 —— 位置会变，概念不会。
                </li>
                <li>
                    <b>视图不可关闭、不可搬</b>：它声明自己在哪个区域的哪，就只在那儿。
                </li>
                <li>
                    <b>只有四边能收起，两种表现方式</b>：标题栏两端放区域图标（收起 = 不占位，空间给 center）；
                    也可以换成「折叠成一条」—— 区域自己收成竖条 / 横条，位置还在。
                </li>
                <li>
                    <b>区域里多个视图时，摆法可配</b>：标签页 / 折叠 / 格子，只换摊开方式，不动骨架。
                </li>
            </ul>
            <p className="wb-dim">每个区域都有头（单击收起 / 双击最大化）；单个视图的区域不给形态菜单。</p>
        </div>
    );
}

function Empty({ children }: { children: string }) {
    return <div className="wb-empty">{children}</div>;
}

export const wbViews = [
    defineView({
        id: 'detail',
        title: '详情',
        placement: { task: { area: 'detail' }, project: { area: 'detail' } },
        render: () => <DetailArea />,
    }),
    defineView({
        id: 'chat',
        title: '对话',
        placement: { task: { area: 'conversation' }, project: { area: 'conversation' } },
        render: () => <ChatBody />,
    }),
    defineView({
        id: 'assets',
        title: '资产',
        placement: { task: { area: 'assets' } },
        render: () => <AssetsArea />,
    }),
    defineView({
        id: 'diag',
        title: '诊断',
        placement: { task: { area: 'diag' }, project: { area: 'diag' } },
        render: () => <DiagArea />,
    }),
    defineView({
        id: 'guide',
        title: '规则',
        placement: { task: { area: 'diag' }, project: { area: 'diag' } },
        render: () => <GuideArea />,
    }),
];
