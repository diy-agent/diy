/**
 * LocalChatPage — 本地自定义 agent 对话页（ai-sdk 块协议，独立于 ACP ChatPage）。
 *
 * ##448 刀 2：从 4718 行单体拆开，**行为零变化**。分工：
 *   · `state.ts`      — 页面级状态（signal / effect / 事件回调），原组件体逐字搬入
 *   · `context.ts`    — 只读分发（只装 store 引用与既有 signal，不装新状态）
 *   · `MessageStream` — 行渲染原语（折叠条 / 摘要 / 工具 / 过程 / 结尾槽）+ `ChatView`
 *   · `TurnView`      — 一轮的块渲染（轮头 / 正文 / 用户气泡 / 过程条 / `TurnView`）
 *   · `RoomRows`      — room 侧三行 + `SteerBar` / `FullscreenModal` / `VirtRow`
 *   · `StreamPanel`   — 视图栏 + 状态横幅 + 块树滚动区
 *   · `Composer`      — 插话横条 + 终态提示 + 输入区
 *   · `SidePanel`     — 抽屉 / 用量卡 / 面板与弹窗
 *   · `useRoomFeed` / `useLocate` — room 时间线与两套定位闭环
 *
 * 一轮 = **过程历史 + 结尾槽 + 状态行**（用户 2026-10-12 R22 口径，草图 rail-v4.html）：
 *   · **过程历史**（`chat-fold.turnRows`，一个 `<For>`）：这轮做过的事（正文 / 工具 / 思考）。
 *     **可折叠** —— 人物栏 chevron 手动开合（`historyOpenOf`）；全局 1-4 级只改"展开多少"。
 *   · **结尾槽**（`tailOf`）：这轮的落点。**自暴露、恒显、不受历史折叠影响、与状态行同级**
 *     —— 四形态：结论 / 结束点 / 现场 / 执行过程。
 *   · **状态行**（`TurnUsageBar`）：末行恒显，上虚线 + 纯文本（不卡片化）。
 *
 * 级别（`lib/chat-fold` 的 TurnLevel）：1 摘要结论 → 2 完整结论 → 3 全部正文 → 4 逐条过程。
 *   **循环只归顶部那个 `n/4 展开` 按钮**（对所有轮次一起换层，且**复位**所有手工痕迹）；
 *   点某一轮的人物标题 bar 只是"把我这一条的历史收拢 / 展开"两态，见 `historyOpenOf`。
 *
 * ⚠️ 历史行**按 key 复用行对象**（见 `rootRows` / `reuseRows`）：`<For>` 按引用判定同一行，
 *   而直播轮的块树节点每帧都是新对象 —— 直接喂新数组会让整块 DOM 每帧重建，后果不是"卡"
 *   而是**点击全丢**（2026-10-11 CDP 实测）。
 * ⚠️ 结尾槽那一条叶子由 `turnRows` **排除在历史行之外**（判据一处：`tailOf`）——
 *   两处判据一分叉就是同一块画两遍（review P1-1）。
 *
 * 「开/关」一律由 `RowGutter` 表达（**行首那一列折叠条**：整块高的一根条 + 首行居中的尖头）。
 * 可展开行头一律 `DisclosureHead`（div + role=button：**按钮内的文本选不中**，见其头注）。
 * 「显示什么、按什么序、开到第几层」的语义全在 `lib/chat-fold.ts`（纯函数 + 单测），本页只管画。
 * MD 渲染/原文是**正交**的显示偏好：摘要态同样按它渲染（见 TextRow）。
 */
import { localChatStore } from "../../store/localChatStore";
import { LocalChatCtx } from "./context";
import { useLocalChatPage, type LocalChatPageProps } from "./state";
import { Composer } from "./Composer";
import { FloatingPanels, SidePanel } from "./SidePanel";
import { StreamPanel } from "./StreamPanel";

// 旧出口名保持不变（`TaskRunPage` / `SidebarRoom` / `RoomsPage` 按名取用）
export { ChatView } from "./MessageStream";
export { TurnView } from "./TurnView";

export function LocalChatPage(props: LocalChatPageProps) {
    const chat = useLocalChatPage(props);
    return (
        <LocalChatCtx.Provider value={chat}>
            <div
                ref={(el) => chat.setRootEl(el)}
                class="flex flex-col h-full overflow-hidden"
                data-testid="local-chat-page"
                /* op 订阅健康度（idle|connecting|live|down）：**唯一**能一眼判"实时通道通不通"的位
                   （单通道化后订阅坏了 = 一个字也看不见，与"模型在想"同形）。落成 DOM 属性 = 可被
                   CDP/意图测试断言（`data-ops-down` 那条常驻条只是它的一个渲染分支）。 */
                data-ops-state={localChatStore.opsState}
            >
                <SidePanel />
                <StreamPanel />
                <Composer />
                <FloatingPanels />
            </div>
        </LocalChatCtx.Provider>
    );
}
