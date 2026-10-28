/**
 * StreamPanel — 会话流（视图栏 + 状态横幅 + 块树滚动区）。
 *
 * 从 `LocalChatPage` 的 JSX 逐字搬出（##448 刀 2）；状态由 `useLocalChatPage` 持有，
 * 这里按名解构（context），不新增 store、不改判据。
 */
import { ErrorBox, nearBottom, turnById } from "./MessageStream";
import { For, Show } from "solid-js";
import { IconChevron, IconCode, IconTrash } from "@diy/ui-kit";
import { OpsDownBar } from "../OpsDownBar";
import { RoomReplyRow, RoomSayRow, VirtRow } from "./RoomRows";
import { TURN_LEVEL_MAX, turnLevelTip } from "../../lib/chat-fold";
import { TurnView } from "./TurnView";
import { VIEW_BAR_H } from "../../lib/layout-metrics";
import { degradedBannerText } from "../../../shared/degraded-history";
import { localChatStore } from "../../store/localChatStore";
import { trafficStore } from "../../store/trafficStore";
import { useLocalChat } from "./context";

function ChatViewBar() {
    const p = useLocalChat();
    const { cycleAllLevels, full, globalLevel, md, moreOpen, setConfirmClear, setGensOpen, setMd, setMoreOpen } = p;
    return (
        <>
                {/* 顶部：对话 view 的**视图级控制**（Markdown 显示方式 + 信息密度 + 清空本会话历史）。
                    pr-16：ViewGrid 的 area 设施（最大化/最小化）浮在本区域**右上角**，
                    不预留这条空档，按钮会与它叠在同一坐标上（实测重叠）。 */}
                <div
                    class={`flex items-center justify-end gap-2 pl-4 pr-16 ${VIEW_BAR_H} border-b shrink-0`}
                >
                    {/* LLM 流量入口：与错误块深链同一个抽屉。常驻在视图栏，用户随时能开，
                        不必先撞上一次错误才知道有这东西（##309(上游偶发 400 不可归因)）。 */}
                    <button
                        class="btn btn-xs btn-ghost shrink-0"
                        data-testid="chat-traffic-btn"
                        data-tip="流量（当前会话实际发出的请求 / 响应）"
                        aria-label="流量"
                        onClick={() => trafficStore.openWith()}
                    >
                        <span class="text-body leading-none">📡</span>
                    </button>
                    {/* 全局展开级别：`n/4 展开` 点一下**所有轮次**换一层（2026-10-11 用户口径：
                        **只有它能换层**）。整段调粗细是高频动作，20 轮逐轮点太累；单轮那边只有
                        "收拢 / 展开"两态（点人物标题 bar，收拢标记见 foldedTurns）。
                        **第 5 层（单条过程内容）不进这个循环** —— 一轮几十个事件、每个几百行，
                        一屏放不下两轮，那份内容只由用户点那一行自己开。 */}
                    <button
                        class="btn btn-xs shrink-0 gap-1"
                        data-testid="chat-level-all"
                        data-level-all={String(globalLevel())}
                        data-tip={turnLevelTip(globalLevel())}
                        aria-label={turnLevelTip(globalLevel())}
                        onClick={cycleAllLevels}
                    >
                        <IconChevron open={globalLevel() > 1} class="h-3.5 w-3.5 opacity-40" />
                        <span class="text-body leading-none">{`${globalLevel()}/${TURN_LEVEL_MAX} 展开`}</span>
                    </button>
                    {/* 显示方式 = **一个开关的两态**，故用单个 `<>` 图标按钮（VSCode「切换源码」范式，##348 ④）。
                        原先摆两个按钮（MD 原文 / MD 渲染）像两个动作，其实是同一开关的两面，白占两格。
                        单按钮最容易犯的错是「看不出当前是哪态」，这里用三处一起说清，不靠用户猜：
                          · 图标按钮的**按下态**（`btn-active` + `aria-pressed` = 正处于原文态）
                          · tooltip 直接写**点一下会去哪**（不是描述当前态）
                          · `data-md` 给测试/自动化一个不随皮肤变的口径
                        用 daisyUI 的 `btn-active` 而不是 `swap`：swap 的两图标交替需要两块图标，
                        而这里只有一个 `<>`（态由底色表达）。 */}
                    <button
                        class="btn btn-xs btn-ghost shrink-0"
                        classList={{ "btn-active": !md() }}
                        data-testid="chat-md-toggle"
                        data-md={md() ? "1" : "0"}
                        aria-pressed={!md()}
                        aria-label="Markdown 显示方式（原文 / 渲染）"
                        data-tip={md() ? "查看 Markdown 原文（纯文本）" : "回到 Markdown 渲染（富文本）"}
                        onClick={() => setMd(!md())}
                    >
                        <IconCode class="h-3.5 w-3.5" />
                    </button>
                    {/* 「⋯」溢出菜单：低频/危险操作的收容处（学 VSCode 视图栏的 ... 附加菜单）。
                        清空历史破坏且不可恢复，常驻图标太显眼（防误删已改三轮：改名/确认/挪位，
                        本轮诉求是**位置/层级**）—— 收进来，点开才露出。
                        生成中整个菜单不显示：正跑着的会话不该在此时被清掉（沿用原行为）。
                        二次确认仍保留（ConfirmDialog 在下方），菜单只解决「太显眼」。 */}
                    <Show when={!localChatStore.live}>
                        <div class="relative shrink-0" data-more-control>
                            <button
                                class="btn btn-ghost btn-xs"
                                data-tip="更多操作（低频 / 危险动作）"
                                aria-label="更多操作"
                                aria-expanded={moreOpen()}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setMoreOpen((v) => !v);
                                }}
                            >
                                <span class="text-body leading-none">⋯</span>
                            </button>
                            <Show when={moreOpen()}>
                                <div
                                    class="absolute right-0 top-full z-20 mt-1 w-48 rounded-box border border-base-300 bg-base-100 p-1 shadow-xl"
                                    data-more-control
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <button
                                        class="btn btn-ghost btn-xs w-full justify-start gap-2 normal-case font-normal"
                                        aria-label="压缩历史"
                                        onClick={() => {
                                            setMoreOpen(false);
                                            setGensOpen(true);
                                        }}
                                    >
                                        压缩历史…
                                    </button>
                                    <button
                                        class="btn btn-ghost btn-xs w-full justify-start gap-2 normal-case font-normal"
                                        aria-label="清空本对话历史"
                                        onClick={() => {
                                            setMoreOpen(false);
                                            setConfirmClear(true);
                                        }}
                                    >
                                        <IconTrash class="h-4 w-4 text-error" />
                                        清空本对话历史
                                    </button>
                                </div>
                            </Show>
                        </div>
                    </Show>
                </div>

        </>
    );
}

function ChatBanners() {
    const p = useLocalChat();
    const { gotoBottom, uri } = p;
    return (
        <>
                {/* 段跳（##389 定位）后显示的是**历史**：块树里没有尾部那一段，必须给出显式回切出口 ——
                    否则用户会以为"会话就到这里"，而其实新消息还在后面（且实时 op 此刻被丢弃，
                    不会自己冒出来）。与 ops 断线条同理：状态的生命周期与状态本身等长。 */}
                <Show when={localChatStore.detached}>
                    <div
                        data-chat-detached="1"
                        role="status"
                        class="flex shrink-0 items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-body"
                    >
                        <span class="shrink-0 font-medium text-warning">正在查看历史</span>
                        <span class="opacity-70">检索定位到的那一段；新消息仍在继续写盘</span>
                        <button
                            class="btn btn-xs btn-warning ml-auto"
                            onClick={() => {
                                const u = uri();
                                if (u) void localChatStore.returnToTail(u).then(() => gotoBottom());
                            }}
                        >
                            回到最新
                        </button>
                    </div>
                </Show>

                {/* 会话实时更新**中断常驻条**（##354 ③；判据 = `localChatStore.opsState === "down"`）。
                    单通道化（##327）之后 op 订阅是实时显示的唯一通道 ⇒ 它断了 = 用户**一个字都看不到**，
                    而那在界面上与"模型还在想"完全同形。常驻：只要有 `down` 这条就在，恢复（markOpsLive）
                    才消失 —— 生命周期与故障本身等长；放在滚动区**之外**（不随消息滚走）。
                    ##391：条上内容（文案 + 「详情」三段 + 每秒刷新的"已断多久"）收口在 OpsDownBar，
                    与恢复 toast 共用同一份机制说明（`lib/notice-ops.ts`）—— 两处说法必须是一个故事。 */}
                <Show when={localChatStore.opsState === "down"}>
                    <OpsDownBar />
                </Show>

                {/* 降级重建横幅（##424 刀 2）：`historyWindow` 回包带 `degraded` ⇒ 现在看到的
                    不是 ops 明细，而是 `turns.jsonl` 折成的**结论文本记录**。
                    为什么必须显式（用户口径）：ops 缺失/断代时静默给空栏，等于让用户以为
                    “这场对话什么都没发生过”—— 那比少显示明细更坏。常量与文案归 shared。 */}
                <Show when={localChatStore.degraded}>
                    {(d) => (
                        <div
                            class="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-1.5 text-body text-warning shrink-0"
                            data-degraded={d().cause}
                            data-degraded-turns={d().turns}
                            data-degraded-dangling={d().dangling}
                        >
                            <span aria-hidden="true">⚠</span>
                            <span>{degradedBannerText(d())}</span>
                        </div>
                    )}
                </Show>

        </>
    );
}

function ChatScrollArea() {
    const p = useLocalChat();
    const { captureAnchor, changeConclusionLines, conclusionLines, full, globalLevel, gotoBottom, histOpenOf, hoverUsageIn, hoverUsageOut, layout, liveTurnId, loadOlderInto, maybeLoadOlder, md, pinned, registerRow, replyOpen, roomEventOf, roomFeed, roomMeta, roomNote, roomRows, rowRO, scrollTop, setFull, setReplyOpen, setScrollTop, setSteerOpen, setStick, setUsageDetail, steerOpen, stick, togglePin, toggleTurn, uri, usageDetail, usageHover, win, windowRows, writeScrollTop } = p;
    return (
        <>
                {/* 块树滚动区 */}
                <div
                    ref={(el) => p.setScrollEl(el)}
                    class="diy-chat flex-1 overflow-y-auto px-4 py-3"
                    /* 诊断 + 不静默：room 侧读到几条外部行、读失败的原因（失败只影响这一层） */
                    data-room-rows={roomRows().length}
                    data-room-says={roomFeed().filter((e) => e.kind === "say").length}
                    data-room-replies={roomFeed().filter((e) => e.kind === "reply").length}
                    data-room-note={roomNote() ?? ""}
                    onScroll={(e) => {
                        // 视口锚点：跟着**实际滚动**走（此刻布局还没变，正是"变化前"的基准）。
                        // 但**我们自己写的**滚动不重取（见 `writeScrollTop`）：那会把锚点挪到旧窗口
                        // 里恰好路过视口顶的别的块上，用户正读的那一块就此丢失。
                        const at = e.currentTarget.scrollTop;
                        const own = p.progWriteTop();
                        const ours = own !== null && Math.abs(at - own) < 1.5;
                        p.setProgWriteTop(null); // 只豁免**紧随的那一次**事件（见 `writeScrollTop`）
                        // ⚠️ **跟随态只由"人的滚动"决定**（##377 第 15 刀）：程序化滚动（`gotoBottom`
                        // 的钉底循环 / 锚点连校 / 布局补偿）也走 `writeScrollTop` ⇒ 也会触发本事件。
                        // 原来无条件 `setStick(nearBottom(...))` ⇒ 钉底循环**第一帧就把自己关掉**
                        // （那一刻还在半路上，`nearBottom` 为假 ⇒ stick=false ⇒ 下一帧 `if (!stick()) return`）
                        // —— 实测症状：打开会话/刷新后视口停在中段（`st=3136`，而底在 `~6974`），
                        // 最新轮不在虚拟化窗口里 = "看不见 agent 刚说的话"。
                        if (!ours) {
                            captureAnchor(e.currentTarget);
                            setStick(nearBottom(e.currentTarget));
                        }
                        // 窗口的输入（虚拟化）：scrollTop 一变就重算该挂哪几行
                        setScrollTop(at);
                        maybeLoadOlder(e.currentTarget);
                    }}
                >
                    {/* 上滚补历史（任务 293）：分页后首载只有「最近一段」，更早的在滚动到这里时补。
                        这一条既是进度指示、是"上面还有"的可见线索（没有它，滚到顶会被读成
                        「会话就这么多」，而其实老内容还在盘上），也是个**可点的补段入口**。
                        ⚠️ 它在**虚拟区之外**（顶部）：虚拟区只放"行"，它随滚动滚出视口 —— 与
                        非虚拟版的位置语义一致。 */}
                    <Show when={localChatStore.hasOlder || localChatStore.olderLoading}>
                        {/* 可点：滚动只是**触发方式之一** —— 窗口渲染高度 ≤ 视口时用户根本
                            滚不出 scroll 事件，只有这条按钮能补出更早的轮（##293 review R5）。 */}
                        <button
                            type="button"
                            data-load-older="1"
                            class="mb-3 flex items-center justify-center gap-2 py-2 text-xs opacity-60 hover:opacity-100 w-full"
                            disabled={localChatStore.olderLoading}
                            onClick={loadOlderInto}
                        >
                            {localChatStore.olderLoading ? "正在加载更早的消息…" : "上滚加载更早的消息"}
                        </button>
                    </Show>
                    {/* 块树列（##301 视口虚拟化）：DOM 里只挂**视口附近若干轮**，其余行用高度账占位。
                        ⚠️ `data-chat-list` **不在这里** —— 它是**每轮的过程历史容器**，见 TurnView：
                        皮肤那条"贯穿线"要画在历史容器上，才只贯穿历史、不穿过结尾与状态。
                        几何（绝对定位 + 前缀和，行间距由账给出）见 lib/chat-virtual 头注。 */}
                    <div class="relative" style={{ height: `${layout().total}px` }}>
                        <For each={windowRows()}>
                            {(row, i) => (
                                <VirtRow
                                    rowKey={row.key}
                                    top={layout().tops[win()[0] + i()] ?? 0}
                                    ro={rowRO}
                                    register={registerRow}
                                >
                                    {row.tag === "turn" ? (
                                        <TurnView
                                            turnId={row.key}
                                            pin={pinned()}
                                            level={globalLevel()}
                                            histOpen={histOpenOf(row.key)}
                                            onCycle={() => toggleTurn(row.key)}
                                            conclusionLines={conclusionLines()}
                                            onResizeLines={changeConclusionLines}
                                            onToggle={togglePin}
                                            onFull={(title, content) => setFull({ title, content })}
                                            liveTurnId={liveTurnId()}
                                            md={md()}
                                            usageHover={usageHover()}
                                            onHoverUsage={(id, el) => hoverUsageIn(id, el)}
                                            onHoverEndUsage={hoverUsageOut}
                                            usageDetail={usageDetail()}
                                            onDetailUsage={(id) => setUsageDetail((d) => (d === id ? null : id))}
                                        />
                                    ) : row.tag === "room-reply" ? (
                                        /* room 里「别人说的话」（##377 第 16 刀）：**只读回显**。
                                           `roomEventOf` 取不到 = 事件已滑出 limit 窗口（少见）——
                                           如实标出，不静默留白 */
                                        <Show
                                            when={roomEventOf(row.key)}
                                            fallback={
                                                <div class="text-body opacity-40">
                                                    [room 事件已不在窗口内]
                                                </div>
                                            }
                                        >
                                            {(ev) => (
                                                <RoomReplyRow
                                                    event={ev()}
                                                    room={roomMeta()}
                                                    roomId={uri() ?? ""}
                                                    open={replyOpen()[ev().id] === true}
                                                    onToggle={() =>
                                                        setReplyOpen((p) => ({
                                                            ...p,
                                                            [ev().id]: p[ev().id] !== true,
                                                        }))
                                                    }
                                                />
                                            )}
                                        </Show>
                                    ) : row.tag === "room-say" ? (
                                        /* room 里「我说的话」中**没投给主人格**的那些（##377 第 17 刀）：
                                           `@dev 帮我看看` —— ops 流里没有它，只能由 room 事件流画 */
                                        <Show
                                            when={roomEventOf(row.key)}
                                            fallback={
                                                <div class="text-body opacity-40">
                                                    [room 事件已不在窗口内]
                                                </div>
                                            }
                                        >
                                            {(ev) => (
                                                <RoomSayRow
                                                    event={ev()}
                                                    room={roomMeta()}
                                                    roomId={uri() ?? ""}
                                                    openOf={(k) => steerOpen()[k] === true}
                                                    onToggleTurn={(k) =>
                                                        setSteerOpen((p) => ({ ...p, [k]: p[k] !== true }))
                                                    }
                                                />
                                            )}
                                        </Show>
                                    ) : row.tag === "error" ? (
                                        /* 遗留的**根级** error 块（历史日志：旧版上限提示未挂 parent）。
                                           新日志已把提示挂进 turn（见 local-agent 的上限分支），但重放旧
                                           ops.jsonl 时根块仍会出现 —— 必须能读懂，不能只吐「[未知根 error]」。
                                           这类块一旦落盘就不再变，故按值取一次即可（不必走 getter） */
                                        <ErrorBox node={turnById(row.key)} />
                                    ) : (
                                        <div class="text-body opacity-40">[未知根 {row.tag}]</div>
                                    )}
                                </VirtRow>
                            )}
                        </For>
                    </div>
                    <Show when={roomNote()}>
                        <div class="text-warning text-caption mt-3" data-room-note-line>
                            {roomNote()}（只影响「别人说的话」这一层，本会话不受影响）
                        </div>
                    </Show>
                    <Show when={localChatStore.error}>
                        <div class="text-error text-body mt-3">{localChatStore.error}</div>
                    </Show>
                </div>

        </>
    );
}

/** 视图栏 + 状态横幅 + 块树滚动区（顺序与拆分前一致） */
export function StreamPanel() {
    return (
        <>
            <ChatViewBar />
            <ChatBanners />
            <ChatScrollArea />
        </>
    );
}
