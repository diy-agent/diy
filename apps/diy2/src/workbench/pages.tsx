// pages.tsx —— 三个页模板 + 全部视图（**宿主侧装配**）。
//
// 这里只有**内容区**：导航不进模板 —— 它是全局层（跨页类型共享宽度与收起），住在
// App.tsx 的壳里。页模板回答的是「这一页除了导航还有什么、各自在哪、多大」。
//
// 区域一律用**概念 id** 声明（`conversation` / `detail` / `assets` / `diag`），`slot` 只说位置。
// 所以「把详情从左侧挪到右侧」= 改一个 `slot`，插在 `detail` 里的 view 一行都不用动。
//
// 页模板的差别只有一处：任务页多一个「资产」区（这一轮聊出来的东西）。这足够说明
// 「骨架按页类型定」—— 同一个区域 id 在别的页里可能根本不存在（assets 在项目页没有），
// 所以折叠入口只能长在区域自己身上：不存在的区域没有条可收，也不该有开关。
//
// 第三个模板 `generic` 兜的不是「以后再说」，而是一个**安全边界**：`Room.type` 是开放
// 字符串（`stock` 之类都可能出现），没有它时未知类型会掉进任务页，详情区拿 `TaskPanel`
// 渲染一个非任务房间 —— 那一按保存就写 `title`、清 `desc`，把别的容器的数据改脏。
// 未知类型只配一个只读信息卡。

import {
    addressOf,
    EntityChatApp,
    navigate,
    TaskPanel,
    useAddress,
    useSelectedRoom,
    type Room,
} from '@diy-agent/entity-chat';

import { useWb } from './AreaHost';
import { ConversationAreaBar } from './ConversationAreaBar';
import { ModelConfigView } from './ModelConfigView';
import { area, definePage, defineView, type PageDef } from './model';
import { RolesView } from './RolesView';
import { rolesAddressOf, rolesTypeOf, SETTINGS_PAGE, SETTINGS_SECTIONS, sectionOf } from './settings';

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
const conversation = () =>
    area('conversation', {
        slot: 'center',
        title: '对话',
        size: 'fr',
        min: 420,
        // 表面切换（Astryx / shadcn）+ 房间菜单：用户要它们「上移为 view 级别」——
        // 长在区域标题栏右端，而不是在对话内容顶上再占一行（见 ConversationAreaBar 注释）。
        bar: <ConversationAreaBar />,
    });

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

/**
 * 未知类型的兜底页：只给对话 + 只读信息卡（没有可写的面板）。
 *
 * 为什么值得单独一个模板，而不是「任务页 + 多判一次 type」：判定只有一处（下面
 * `pageFor`），详情区照旧只认 `page.type` —— 否则「哪一页该给可写面板」这件事就有两份
 * 判断（pageFor 一份、DetailArea 一份），迟早对不上。
 */
export const genericPage = definePage({
    type: 'generic',
    title: '房间',
    center: conversation(),
    sides: [
        area('detail', { slot: 'left', title: '房间信息', size: 320, min: 240 }),
        area('diag', { slot: 'bottom', title: '诊断', size: 200, min: 120, initial: 'collapsed' }),
    ],
});

/**
 * 设置页：只有 center，没有四边 —— 它的内容是**按段**换的（模型 / 角色）。
 *
 * 它不由房间派生（`pageFor` 不认识它）—— 但它是**真的页**，地址是 `/settings/<段>`
 * （`registerPage('settings')` + `navigate`，见 `App.tsx` 文件头）。所以：
 *   · 点左边导航里的房间 = 导航到房间地址，设置页自然就退出去了；
 *   · 浏览器后退回得去，链接贴得住，刷新回到设置页而不是跳回对话。
 * 这条区分很重要：设置不属于任何房间，删掉房间也不该把它带走。
 *
 * 段不是新的一套骨架（那会让「模型」和「角色」各一份偏好键），而是**同一个中心区域**
 * 里换内容：段在地址上（`SETTINGS_SECTIONS`），骨架不动。
 */
export const settingsPage = definePage({
    type: SETTINGS_PAGE,
    title: '设置',
    center: area('settings', { slot: 'center', title: '设置', size: 'fr', min: 480 }),
});

/**
 * 房间类型 → 页模板。**唯一一处**这个判断，别在别处再抄一份。
 *
 * `Room.type` 是开放字符串（见 agent/protocol 的 Room），所以必须有兜底：只认
 * `task` / `project`，其余一律 generic。
 */
export function pageFor(type: string): PageDef {
    if (type === 'task') return taskPage;
    if (type === 'project') return projectPage;
    return genericPage;
}

// ── 视图 ────────────────────────────────────────────────────────────────────────

/**
 * 对话：只留主区。导航 / 详情 / 资产各归自己的区域 —— 一个布局只该有一个真源。
 *
 * 房间头模型胶囊 /「角色」按钮点开的是二级配置面板（实体聊天包内），面板最后一步
 * 「全部设置 →」需要一个「去角色页」的动作：实体聊天包不认识设置页的地址，
 * 所以由宿主（这一层）给 —— 这也让 `entity-chat` 保持「不知道自己被装在哪」。
 *
 * 深链带**房间类型**（`/settings/roles/task`）：从任务房间的面板点进去就落在那类角色上，
 * 项目房间落 `project`，其余类型由 `rolesAddressOf` 回落整表。
 */
function ChatBody() {
    const room = useSelectedRoom();
    return (
        <div className="wb-chat">
            <EntityChatApp
                sidebar={false}
                taskPanel={false}
                bar="host"
                onManageRoles={() => navigate(rolesAddressOf(room?.type ?? ''))}
            />
        </div>
    );
}

/**
 * 设置页的内容：按地址第二段换（`/settings/model` ↔ `/settings/roles`）。
 *
 * 段在**地址**上而不是组件状态里：切段 = 导航，于是后退 / 刷新 / 贴链接全都不用额外写。
 * 顶上那排是段的入口（两个 tab），不是新壳 —— 骨架仍然是设置页那一个中心区域。
 */
function SettingsBody() {
    const address = useAddress();
    const section = sectionOf(address.id);
    return (
        <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
            <div className="flex items-center gap-1 border-b border-border px-3 py-1.5 text-xs">
                {Object.values(SETTINGS_SECTIONS).map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        onClick={() => navigate(addressOf(SETTINGS_PAGE, item.id))}
                        className={`rounded-md px-2 py-1 ${
                            section === item.id ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60'
                        }`}
                    >
                        {item.label}
                    </button>
                ))}

            </div>
            <div className="min-h-0 flex-1">
                {section === 'roles' ? (
                    // `key` 按地址重置：从任务房间（`roles:task`）切到项目房间（`roles:project`）
                    // 时组件类型不变、state 会留下 —— 不加 key 就会「进了 project 还选着 task 的角色」。
                    // 同一地址（用户自己在左栏点选）不重挂载，选中不被地址抢回去。
                    <RolesView key={address.id} initialType={rolesTypeOf(address.id)} />
                ) : (
                    <ModelConfigView />
                )}
            </div>
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

/** 房间信息（项目页 / 未知类型页共用）：id / type / data 长什么样 —— 只读 */
function InfoCard({ room }: { room: Room }) {
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
 * 详情区：任务页给真任务面板，其它页给只读信息卡。
 *
 * 判据用 `page.type`（页模板）而不是 `room.type` —— 页模板是 `pageFor` 算出来的，
 * 同一个房间将来可能被别的东西覆盖成另一页；两处各判一次迟早对不上。未知类型
 * 落到 generic 页，自然拿到信息卡，不会拿到一个会写数据的任务面板。
 */
function DetailArea() {
    const api = useWb();
    const room = useSelectedRoom();
    if (!room) return <Empty>没有选中房间</Empty>;
    return api.page.type === 'task' ? <TaskDetail room={room} /> : <InfoCard room={room} />;
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
        placement: {
            task: { area: 'detail' },
            project: { area: 'detail' },
            generic: { area: 'detail' },
        },
        render: () => <DetailArea />,
    }),
    defineView({
        id: 'chat',
        title: '对话',
        placement: {
            task: { area: 'conversation' },
            project: { area: 'conversation' },
            generic: { area: 'conversation' },
        },
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
        placement: {
            task: { area: 'diag' },
            project: { area: 'diag' },
            generic: { area: 'diag' },
        },
        render: () => <DiagArea />,
    }),
    // 设置页（写面在 entity-chat 的 `modelConfig` / `roles`，页面本体的观感照 demo）。
    // 中心区域里按地址第二段换内容 —— 见 `SettingsBody`。
    defineView({
        id: 'settings',
        title: '设置',
        placement: { [SETTINGS_PAGE]: { area: 'settings' } },
        render: () => <SettingsBody />,
    }),
    defineView({
        id: 'guide',
        title: '规则',
        placement: {
            task: { area: 'diag' },
            project: { area: 'diag' },
            generic: { area: 'diag' },
        },
        render: () => <GuideArea />,
    }),
];
