/**
 * SidePanel — 页面级浮层（抽屉 / 用量 hover 卡 / 历史面板 / 检索面板 / 门禁与确认弹窗 / 全屏输出）。
 *
 * 从 `LocalChatPage` 的 JSX 逐字搬出（##448 刀 2）；状态由 `useLocalChatPage` 持有。
 */
import { Show } from "solid-js";
import { ChatFindPanel } from "../ChatFindPanel";
import { CompactHistoryPanel } from "../CompactSessionPanel";
import { ConfirmDialog } from "@diy-agent/ui-kit";
import { FullscreenModal } from "./RoomRows";
import { InputLimitDialog } from "../InputLimitDialog";
import { PersonaDrawer } from "../PersonaDrawer";
import { TrafficDrawer } from "../TrafficDrawer";
import { TurnUsageDetailDrawer, UsageDrawer, UsageHoverCard, cancelHoverClose } from "../UsagePanel";
import { chatFindStore } from "../../store/chatFindStore";
import { clearHitHighlight } from "../../lib/hit-highlight";
import { localChatStore } from "../../store/localChatStore";
import { useLocalChat } from "./context";

function Drawers() {
    const p = useLocalChat();
    const { hoverUsageOut, liveTurnId, personaPanelOpen, setPersonaPanelOpen, setUsageBoard, setUsageDetail, setUsageHover, uri, usageBoard, usageDetail, usageHover } = p;
    return (
        <>
                <PersonaDrawer open={personaPanelOpen()} onClose={() => setPersonaPanelOpen(false)} />
                {/* 打开时顺手对一次账本（轮次间隙别人跑的那几轮不该漏） */}
                <UsageDrawer open={usageBoard()} uri={uri()} onClose={() => setUsageBoard(false)} />
                {/* L3：本轮逐步明细抽屉（覆盖式；turnId 页面级，单实例） */}
                <TurnUsageDetailDrawer
                    turnId={usageDetail()}
                    live={liveTurnId() === usageDetail()}
                    onClose={() => setUsageDetail(null)}
                />
                {/* 流量抽屉（当前会话的请求/响应；错误块「查看实际请求 / 响应」深链打开） */}
                <TrafficDrawer />
                {/* L2：用量汇总 hover 卡（Portal 到 body，滚动容器裁不到） */}
                <UsageHoverCard
                    state={usageHover()}
                    onEnter={cancelHoverClose}
                    onLeave={hoverUsageOut}
                    onDetail={(id) => {
                        cancelHoverClose();
                        setUsageHover(null);
                        if (id === "session") setUsageBoard(true);
                        else setUsageDetail(id);
                    }}
                />
        </>
    );
}

function FloatingPanels() {
    const p = useLocalChat();
    const { confirmClear, full, gateBusy, gensOpen, inputGateAsk, locateHit, sendAnyway, sendViaFile, setConfirmClear, setFull, setGensOpen, setInputGateAsk, uri } = p;
    return (
        <>
                <Show when={gensOpen() && uri()}>
                    <CompactHistoryPanel uri={uri()!} onClose={() => setGensOpen(false)} />
                </Show>
                {/* 数据层检索面板（##389）：⌘⇧F 开合；「跳」走本组件的 locateHit（见其上注释） */}
                {/* 只由**当前任务这一页**渲染：多开 tab 时本组件可能同时存活多份，而面板状态是
                    单例 store —— 不判归属就会出现两个面板（一个查 A、一个查 B），互相盖住。 */}
                <Show when={chatFindStore.open && chatFindStore.taskUri === uri()}>
                    <ChatFindPanel
                        taskUri={uri}
                        onLocate={locateHit}
                        onClose={() => {
                            chatFindStore.close();
                            clearHitHighlight();
                        }}
                    />
                </Show>
                {/* 超长输入门禁（##426 B）：只有 over 才会挂上这个节点 */}
                <Show when={inputGateAsk()}>
                    {(ask) => (
                        <InputLimitDialog
                            gate={ask().gate}
                            busy={gateBusy()}
                            onCancel={() => setInputGateAsk(null)}
                            onToFile={() => void sendViaFile()}
                            onStillSend={() => void sendAnyway()}
                        />
                    )}
                </Show>

                {/* 清空确认：破坏性且不可恢复，点击与执行之间隔一层确认 */}
                <Show when={confirmClear()}>
                    <ConfirmDialog
                        title="清空本对话历史消息？"
                        /* ⚠️ 必须点明插话也被删：main 的 clear() 会一并清空插话队列
                           （local-agent 的 queue.clear），而插话与草稿同级 —— 属"丢了 = 用户白打"的
                           不可重建数据。只写"对话记录"会让用户在不知情下丢掉排队中的留言。 */
                        message={`将删除「${uri() ?? ""}」的全部本地对话记录（消息、思考、工具调用过程）${
                            localChatStore.steers.length > 0
                                ? `，以及排队中的 ${localChatStore.steers.length} 条插话`
                                : ""
                        }，删除后无法恢复。`}
                        confirmLabel="清空"
                        onCancel={() => setConfirmClear(false)}
                        onConfirm={() => {
                            setConfirmClear(false);
                            if (uri()) void localChatStore.clear(uri()!);
                        }}
                    />
                </Show>

                {/* 全屏输出 */}
                <Show when={full()}>
                    {(f) => (
                        <FullscreenModal
                            title={f().title}
                            content={f().content}
                            onClose={() => setFull(null)}
                        />
                    )}
                </Show>
        </>
    );
}

/** 抽屉 / 用量卡（页面顶部浮层；顺序与拆分前一致） */
export function SidePanel() {
    return <Drawers />;
}

/** 页面底部的面板与弹窗（`CompactHistoryPanel` / 检索 / 门禁 / 确认 / 全屏）：**恒在最后**渲染 */
export { FloatingPanels };
