/**
 * Composer — 插话横条 + 终态只读提示 + 输入区（发送 / 停止 / 附件 / 快捷键）。
 *
 * 从 `LocalChatPage` 的 JSX 逐字搬出（##448 刀 2）；状态由 `useLocalChatPage` 持有。
 */
import type { ReasoningEffort } from "../../../main/services/local-agent";
import { IconCompress, IconExpand } from "@diy-agent/ui-kit";
import { Match, on, Show, Switch } from "solid-js";
import { MdEditor } from "../MdEditor";
import { NoticeDetail } from "../NoticeDetail";
import { SessionUsageChip, WindowRing, OverallRateChip } from "../UsagePanel";
import { SteerBar } from "./RoomRows";
import { draftStore } from "../../store/draftStore";
import { localChatStore } from "../../store/localChatStore";
import { personaStore } from "../../store/personaStore";
import { reasoningEffortLabel } from "../../../shared/reasoning-effort";
import { useLocalChat } from "./context";

function SteerStrip() {
    const p = useLocalChat();
    const { cancelSteer, editSteer, flushSteerQueue, fullscreen, reorderSteers, toggleSteerMode } = p;
    return (
        <>
                {/* 待发送插话横条（正常态）：贴着输入区上方一行 —— 队列是"还没发生的事"，
                    不该混进上面的对话流（那里是历史） */}
                <Show when={!fullscreen()}>
                    <SteerBar
                        items={localChatStore.steers}
                        onCancel={cancelSteer}
                        onToggleMode={toggleSteerMode}
                        onReorder={reorderSteers}
                        onEdit={(id) => void editSteer(id)}
                        onFlush={flushSteerQueue}
                    />
                </Show>

        </>
    );
}

function ClosedNote() {
    const p = useLocalChat();
    const { closedInfo, closedMeta, fullscreen } = p;
    return (
        <>
                {/* 终态任务（##400）：输入区只读 + 一条静态提示。**拒绝的判据在服务端**，
                    这里只是把"按了也没用"提前说出来，并给 ##391 三问详情。 */}
                <Show when={!fullscreen() && closedInfo()}>
                    <div class="border-t px-3 py-2 shrink-0" data-session-closed>
                        <div class="flex items-start gap-2 rounded-field border border-base-300 bg-base-200 p-2 text-body">
                            <span class="opacity-70" aria-hidden="true">🔒</span>
                            <div class="min-w-0 flex-1">
                                <div class="font-semibold">
                                    {closedInfo()!.reason} · 本会话不再接受新消息（历史仍可查看）
                                </div>
                                <div class="whitespace-pre-wrap opacity-70">{closedInfo()!.detail}</div>
                            </div>
                            <Show when={closedMeta()}>
                                {(m) => (
                                    <NoticeDetail
                                        meta={m()}
                                        message={`${closedInfo()!.reason} · 本会话不再接受新消息`}
                                    />
                                )}
                            </Show>
                        </div>
                    </div>
                </Show>
        </>
    );
}

function ComposerInput() {
    const p = useLocalChat();
    const { cancelSteer, chatCompletions, closedInfo, editSteer, flushSteerQueue, full, fullscreen, hoverUsageIn, hoverUsageOut, inputMaxH, inputValue, overallRate, personaDef, reorderSteers, setFullscreen, setInputValue, setPersonaPanelOpen, setUsageBoard, submit, submitByEnter, toggleSteerMode, uri, usageHover } = p;
    return (
        <>
                {/* 输入框：Markdown 源码编辑、随内容增长，控制项置于框内底部。 */}
                <div class="border-t p-3 shrink-0">
                    {/* 定位类必须二选一：Tailwind 里 `relative` 排在 `fixed` 之后，
                        两个同时挂上会让 `fixed` 失效（实测全屏退化成原地 147px 高）。

                        底色用 base-200 —— 也就是编辑器里"当前行"的那档加深色：整块（正文 + 底部
                        工具条）连成一片，读起来是"一个凹进去的输入区"，而不是白底卡片上贴一条按钮。
                        编辑器侧同步传 `embedded`，让它的纸面透明、当前行再深一档（base-300）。

                        边框照抄 daisyUI `.input` 的 token 语义（它是 5.x 里唯一的**容器式**输入控件：
                        `.input input { border:none }` + `:focus-within` 联动）。多行编辑器 + 底部工具条
                        装不进 `.input`（单行 `height:var(--size)`）也装不进 `.textarea`（非 flex，且
                        textarea 无子元素），故手写容器但复用同一套变量：
                          · 静息：`--input-color` = base-content 20% → `border-base-content/20`
                          · 聚焦：`--input-color` = base-content → `focus-within:border-base-content`
                            **只变色、不加 outline**：outline 画在 border 外侧 2px，看着像"多了一圈
                            边框"（实测双边框感），边框自己变色就够表达了。
                          · 圆角：`--radius-field`（输入类控件语义，比 `--radius-box` 更方正） */}
                    {/* R5 封顶加在**这个盒子**（= 用户眼里的「输入框」：正文 + 底部工具条）上，而不是
                        只加在正文宿主上。封顶的**主语**必须与需求一致 —— review2-2 实测：只封宿主时
                        整个输入区比 view/3 高出 50px（工具条那一行没算进去），后人按"整体 1/3"去改测试
                        就会对不上。`flex flex-col` 是让工具条（shrink-0）与正文（flex-auto）在盒子里分高度：
                        内容少时两者都按内容高（默认一行）；超过 max-height 时只有正文收缩 + 内部滚动。 */}
                    <div
                        class={`rounded-field border border-base-content/20 bg-base-200 transition-colors focus-within:border-base-content ${fullscreen() ? "fixed inset-4 z-40 flex min-h-0 flex-col p-4" : "relative flex flex-col"}`}
                        style={fullscreen() ? undefined : { "max-height": inputMaxH() }}
                        /* 焦点锚点：撤回留言后要把光标送回这里（见 editSteer / focusInput） */
                        data-agent-input
                    >
                        {/* 全屏时横条挪进这块 fixed 区域顶部：正常态那份被遮罩盖住看不见，
                            同一时刻只有一处渲染（同一份数据不重复画） */}
                        <Show when={fullscreen()}>
                            <div class="rounded-field border border-base-300 mb-2">
                                <SteerBar
                                    items={localChatStore.steers}
                                    onCancel={cancelSteer}
                                    onToggleMode={toggleSteerMode}
                                    onReorder={reorderSteers}
                                    onEdit={(id) => void editSteer(id)}
                                    onFlush={flushSteerQueue}
                                />
                            </div>
                        </Show>
                        {/* 全文编辑开关：输入框**右上角**，daisyUI swap（小↔大 双向动画）。
                            用 label+checkbox 而不是 button：swap 的语义就是「两种状态的开关」。 */}
                        <label
                            class="btn btn-ghost btn-xs swap swap-rotate absolute right-1 top-1 z-10"
                            data-tip={fullscreen() ? "退出全文编辑（Esc）" : "全文编辑（放大）"}
                            aria-label={fullscreen() ? "退出全文编辑" : "全文编辑"}
                        >
                            <input
                                type="checkbox"
                                checked={fullscreen()}
                                onChange={(e) => setFullscreen(e.currentTarget.checked)}
                            />
                            {/* 与 area chrome 共用同一套图标（四角外/内），不再内联重复 path */}
                            <IconExpand class="swap-off h-4 w-4" />
                            <IconCompress class="swap-on h-4 w-4" />
                        </label>
                        {/* pr-8：正文不要钻到右上角按钮底下 */}
                        {/* 全屏时 `flex-1` 不能丢：面板是 `fixed inset-4 flex flex-col`，正文宿主
                            没有 flex-grow 就成了内容高的项 → 内容少时缩成一条（R5 review1-1 实测：
                            面板 683px、编辑区仅 23px，「全文编辑」形同虚设）。
                            正常态用 `flex-auto`（basis = 内容高）而不是 `flex-1`（basis = 0）——
                            basis 0 在"高度由内容决定"的盒子里会把正文压成 0 高；而 basis auto 只在
                            盒子被 max-height 卡住时才收缩（收缩权在正文，工具条 shrink-0 不动）。 */}
                        <div
                            class={`min-h-0 overflow-auto px-2 pt-2 pr-8 ${fullscreen() ? "flex-1" : "flex-auto"}`}
                        >
                            <MdEditor
                                value={inputValue()}
                                /* ⚠️ 输入框**不因生成中而锁死**。理由有两条，第二条是硬约束：
                                     ① 锁输入框只是"别发"的视觉暗示，真正的守门在 submit()
                                        （`if (live) return`）与 main 侧的并发拒发 —— 锁住它并不能多防住
                                        什么，却会让人打好的字没法留存；
                                     ② 插话（"插嘴"）的前提就是**能打字**：旧行为把输入框锁死，
                                        等于强迫用户等模型跑完，本轮次的插话需求无从表达。
                                   onEnter 按状态分流：生成中 = 留言，否则 = 发送（见 submitByEnter）。 */
                                editable={!closedInfo()}
                                onChange={(v) => {
                                    setInputValue(v);
                                    const u = uri();
                                    if (u) draftStore.set(u, "agent_input", v);
                                }}
                                onEnter={submitByEnter}
                                /* 两个源：`##` 任务引用（第 11 刀）+ `@` 成员寻址（第 17 刀 —— 任务页
                                   从"没有成员概念"变成"有 room 了"，成员源 = **本任务 room 的成员**，
                                   与侧边栏各用各的）。`chatCompletions` 是 memo 稳引用（见其定义处）。 */
                                completions={chatCompletions()}
                                wrap
                                lineNumbers={fullscreen()}
                                embedded
                            />
                        </div>
                        {/* 不再画分隔线：正文与工具条同底色（base-200），一条 border-base-300 的横线
                            会在"一体化"的块里切出一道比底色更亮/更暗的缝，比没有线更显割裂。 */}
                        <div class="flex shrink-0 items-center gap-2 px-2 py-2 text-body">
                            {/* 人物入口：打开人物面板（选/改/换绑都在那里）。
                                按钮本身显示**本任务当前用谁 + 它的模型与档位** ——
                                "我这条消息会发给哪个模型"必须一眼可见，不用点开才知道。 */}
                            <button
                                class="btn btn-ghost btn-xs max-w-[280px] min-w-0"
                                data-tip="agent 人物：选择绑定 / 跟随缺省，编辑模型与参数（改人物会影响所有引用它的任务）"
                                aria-label="打开 agent 人物面板"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setPersonaPanelOpen(true);
                                }}
                            >
                                <span class="truncate">
                                    {/* 跟随缺省时显式写出来：「谁在干活」与「是不是我固定绑的」是两件事，
                                        只显示人物名会让人以为"这个任务固定用了它"，而其实缺省一改就跟着变 */}
                                    <Show when={personaStore.isFollowing()}>
                                        <span class="badge badge-xs badge-ghost mr-1">跟随缺省</span>
                                    </Show>
                                    {personaDef()?.name ?? "选择人物"}
                                    <span class="opacity-60">
                                        （
                                        {personaDef()
                                            ? `${personaStore.displayModel(personaDef()!.model)} · ${reasoningEffortLabel(personaDef()!.reasoningEffort as ReasoningEffort)}`
                                            : "加载中…"}
                                        ）
                                    </span>
                                </span>
                                <span class="opacity-50">⚙</span>
                            </button>
                            {/* L1② 会话累计 chip（紧贴人物右侧的空白区）：hover 出 L2 汇总卡，
                                卡上「明细」开 L3 看板。页面级状态，与 turn 底 bar 同构。 */}
                            <SessionUsageChip
                                hover={usageHover()?.id === "session"}
                                onHover={(el) => hoverUsageIn("session", el)}
                                onHoverEnd={hoverUsageOut}
                                onDetail={() => setUsageBoard(true)}
                            />
                            {/* L1 窗口占用环（chip 的 token/金额总量右侧）：hover 出构成卡（含「压缩」按钮 + 可降低窗口比较条）。
                                【用户 2026-10-07】压缩入口**移进 token 窗口的 card**（不再单独一个按钮）；生成中禁用+提示。 */}
                            <WindowRing uri={uri()} />
                            {/* ⌀ 底部汇总行的总均速度（##349 三档之"总均"；口径见 overallRate）：与轮尾那枚
                                不重复 —— 轮尾给"本轮"（⚡实时 / ⌀轮均），这里给"全局"。放在**常驻**位置 ——
                                轮尾那行会随滚屏移出视野，而"整体跑得快不快"是常驻参考。 */}
                            <OverallRateChip rate={overallRate()} />
                            <div class="flex-1" />
                            {/* 停止（两种观感：收尾中 / 生成中）+ **发送（恒在）**。
                                停止按钮**不分谁发起的**：main 报告活跃就给入口（含 CLI 那轮）；
                                外观沿用 steer 分支的 aura 装饰。
                                ⚠️ 发送按钮不再藏起来（##377 第 27 刀）：忙时它照样能按 —— 那条发言
                                先落 room，再由投递层插进正在跑的那一轮（与侧边栏同一套语义）。
                                原来"忙时只给停止、另给一个小『留言』按钮"= 两个入口两套语义，
                                而『留言』那条根本不进 room。 */}
                            <Switch>
                                <Match when={localChatStore.view.stopping}>
                                    {/* 收尾期间**不许**退回"生成中"：那样输入框会解锁、发送按钮出现，
                                        而服务端仍会拒发（它眼里还在生成）—— 界面与服务端结论相反。
                                        卡住（超过宽限期 main 仍报活跃）时不装死，给一个更强的出口：
                                        再点一次 = 重发中断（main 侧 abort 幂等，可安全重复）。 */}
                                    <span class="text-body opacity-60">
                                        {localChatStore.view.stoppingStuck ? "已停止，仍在收尾（可强制中断）…" : "已停止，后台收尾中…"}
                                    </span>
                                    <div class="aura text-error rounded-full" style={{ "--aura-padding": "2px", "--tw-duration": "2.4s" }}>
                                        <button
                                            class="btn btn-error btn-sm"
                                            data-tip={
                                                localChatStore.view.stoppingStuck
                                                    ? "收尾超时；再点一次强制中断（可重复，main 侧幂等）"
                                                    : "正在收尾…"
                                            }
                                            disabled={!localChatStore.view.stoppingStuck}
                                            onClick={() => uri() && void localChatStore.cancel(uri()!)}
                                        >
                                            {localChatStore.view.stoppingStuck ? "强制中断" : "停止中…"}
                                        </button>
                                    </div>
                                </Match>
                                <Match when={localChatStore.view.busy}>
                                    <div class="aura text-error rounded-full" style={{ "--aura-padding": "2px", "--tw-duration": "2.4s" }}>
                                        <button
                                            class="btn btn-error btn-sm"
                                            data-tip="中断本轮生成（保留已产出内容；由其他端发起的轮次同样可停）"
                                            onClick={() => uri() && void localChatStore.cancel(uri()!)}
                                        >
                                            停止
                                        </button>
                                    </div>
                                </Match>
                            </Switch>
                            {/* 发送：**恒在**（忙时 = 排队/插话，见上） */}
                            <button
                                class="btn btn-primary btn-sm"
                                data-tip={
                                    localChatStore.view.busy
                                        ? "发送（回车）：本轮在跑 ⇒ 这句话投进当前这轮（下一步生效），并落进房间"
                                        : "发送（回车发送 / Shift+回车换行）"
                                }
                                onClick={() => void submit()}
                            >
                                发送
                            </button>
                        </div>
                    </div>
                </div>

        </>
    );
}

/** 插话横条 + 终态提示 + 输入区（顺序与拆分前一致） */
export function Composer() {
    return (
        <>
            <SteerStrip />
            <ClosedNote />
            <ComposerInput />
        </>
    );
}
