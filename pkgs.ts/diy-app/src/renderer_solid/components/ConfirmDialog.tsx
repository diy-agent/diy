// components/ConfirmDialog.tsx — 破坏性操作的**应用内**二次确认弹窗。
//
// 为什么不用原生 window.confirm：它由 Chromium 弹「窗口级模态」—— 弹出期间整个渲染进程
// 停摆（应用自己的 UI、agent 的操作界面一起卡住），而且它不是 DOM 节点：自动化（CDP /
// playwright）拿不到它，只能走 dialog 事件旁路（ModelConfigPage 的「移除 provider」踩过）。
// 本组件是普通 DOM 节点：可见、可点、可键盘操作、可被自动化直接点，风格与应用一致。
//
// 键盘：Esc = 取消（捕获阶段 + stopPropagation，一次 Esc 只关弹窗）；焦点默认落「取消」，
// 回车即取消 —— 破坏性操作不该被一次回车误触发。
import { onMount, onCleanup } from "solid-js";

export function ConfirmDialog(props: {
  title: string;
  message: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  let cancelRef: HTMLButtonElement | undefined;
  const onKey = (e: KeyboardEvent) => {
    // 只拦 Esc；不拦 Enter —— 焦点默认在「取消」上，回车本就是取消（原生行为），
    // 而 Tab 到「清空」后回车应能正常确认：全局拦 Enter 会把这条路一起掐掉。
    if (e.key === "Escape") {
      e.stopPropagation();
      props.onCancel();
    }
  };
  onMount(() => {
    // ⚠️ 不能用 HTML autofocus：它只在文档加载时生效，动态插入的节点上无效
    // （实测焦点留在原按钮上，回车会误触原按钮）。必须主动 focus。
    cancelRef?.focus();
    // 捕获阶段 + stopPropagation：弹窗开着时 Esc 只该关弹窗。
    // TaskDetailPanel 也在 window 上监听 Esc 关整个详情面板（冒泡阶段），
    // 不拦的话一次 Esc 会连面板一起关掉（弹窗和面板双杀）。
    document.addEventListener("keydown", onKey, true);
  });
  onCleanup(() => document.removeEventListener("keydown", onKey, true));
  return (
    <div
      class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onCancel();
      }}
    >
      <div class="bg-base-100 rounded-xl w-full max-w-sm flex flex-col">
        <div class="px-4 py-3 border-b font-bold text-title">{props.title}</div>
        <div class="px-4 py-3 text-body opacity-80">{props.message}</div>
        <div class="px-4 py-2 border-t flex justify-end gap-2">
          {/* 焦点落在「取消」：回车/空格不会误触发不可恢复的删除 */}
          <button
            class="btn btn-xs"
            ref={(el) => (cancelRef = el)}
            onClick={props.onCancel}
          >
            取消
          </button>
          <button class="btn btn-error btn-xs" onClick={props.onConfirm}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
