// components/ChatSkinPreview.tsx — 外观设置里的**皮肤实时小样**
//
// 为什么要它：设置页会**整体顶掉主内容区**（聊天区此时不在 DOM）⇒ 在外观里点"竖栏/卡片"，
// 屏幕上没有任何东西会变 —— 用户只能看到按钮 active 变了下，必然得出"样式设置无效"的结论
// （2026-10-12 实测复现：切皮肤时 `document.querySelectorAll('.diy-chat').length === 0`）。
// 小样把 agent 输出区的一小段搬进设置页 ⇒ 切换所见即所得，且**零逻辑**：样式规则全靠
// index.css 的 `[data-skin]` 段（`data-skin` 挂在 documentElement 上，切换即全局生效）。
//
// 硬约束：钩子必须与真实 DOM 一致，否则小样会"撒谎"（显示的差异不是真差异）。
//   · `data-testid="turn-header"` → LocalChatPage 的 TurnHeader
//   · `data-block-tag="proc-bar"` 且**子元素带 `role="button"`** → 过程 bar 的命中形状
//   · `data-tail-box`（+ `data-failing`）/ `data-block-tag="proc-bar"[data-has-error]` → 结尾槽与出错态
// 一致性由 `tests/core/chat-skin-preview.test.ts` 守住：直接拿 index.css 里 `[data-skin]`
// 段出现过的钩子来核对本文件 —— 以后加皮肤规则若忘了在小样补钩子，测试就红。
//
// 小样元素**不带自己的 border/bg**（真实块上那些 utility 会被皮肤规则按特异性盖掉）：
// 这里只留排版类，让"形状"100% 由皮肤规则决定，切换时差异才是纯粹的皮肤差异。

/** 小样承诺覆盖的皮肤钩子（与 index.css `[data-skin]` 段对齐；测试的唯一核对清单） */
export const SKIN_PREVIEW_HOOKS = [
  'data-testid="turn-header"',
  'data-block-tag="proc-bar"',
  'data-has-error',
  'data-tail-box',
  'data-failing',
  'data-chat-list',
] as const;

export function ChatSkinPreview() {
  return (
    <div class="diy-chat space-y-1.5 rounded-lg border border-base-300/70 bg-base-100/50 p-2" data-testid="skin-preview">
      <div class="px-0.5 pb-0.5 text-caption opacity-50">小样（切换即时生效；与真实输出同一套规则）</div>
      {/* 块树列 = rail 那条贯穿线的作用点（真实聊天页同钩子，见 LocalChatPage 的块树列） */}
      <div class="space-y-1.5" data-chat-list>
      {/* 人物栏：一级标题行 —— rail 靠线 + 缩进，card 自带卡片底 */}
      <div
        class="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-body"
        data-testid="turn-header"
        data-block-tag="turn"
        data-level="3"
      >
        <span class="h-3.5 w-3.5 opacity-40" aria-hidden="true">
          ▾
        </span>
        <span
          class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-body"
          aria-hidden="true"
        >
          🤖
        </span>
        <span class="min-w-0 truncate font-medium">大副</span>
        <span class="shrink-0 opacity-50">·</span>
        <span class="min-w-0 truncate opacity-60">mimo-v2.6-flash</span>
      </div>
      {/* 过程 bar：命中形状是 `[data-block-tag="proc-bar"] > [role="button"]` */}
      <div data-block-tag="proc-bar" data-block-id="skin-preview-proc">
        <div class="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-body" role="button" tabindex="-1">
          <span class="h-3.5 w-3.5 opacity-40" aria-hidden="true">
            ▸
          </span>
          <span class="shrink-0 rounded bg-base-300/60 px-1 text-caption tabular-nums opacity-70">3 思考 · 5 工具</span>
          <span class="truncate opacity-60">执行过程</span>
        </div>
      </div>
      {/* 一顿出错的过程 bar：只有错误/警告吃色（判据两皮肤一致） */}
      <div data-block-tag="proc-bar" data-block-id="skin-preview-proc-err" data-has-error="1">
        <div class="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-body" role="button" tabindex="-1">
          <span class="h-3.5 w-3.5 opacity-40" aria-hidden="true">
            ▸
          </span>
          <span class="shrink-0 rounded bg-base-300/60 px-1 text-caption tabular-nums opacity-70">0 思考 · 2 工具</span>
          <span class="truncate text-error">工具出错</span>
        </div>
      </div>
      {/* 结尾槽（结论）：恒显、与状态同级 */}
      <div data-tail-box="scene" class="rounded-lg px-2 py-1.5 text-body">
        <div class="flex items-center gap-1.5">
          <span class="h-3.5 w-3.5 opacity-40" aria-hidden="true">
            ▸
          </span>
          <span class="text-base-content/80">✓ 结论</span>
        </div>
      </div>
      {/* 结尾槽（失败现场）：框原地转红 */}
      <div data-tail-box="scene" data-failing="1" class="rounded-lg px-2 py-1.5 text-body">
        <div class="flex items-center gap-1.5">
          <span class="h-3.5 w-3.5 opacity-40" aria-hidden="true">
            ▸
          </span>
          <span class="text-error">✗ 出错现场</span>
        </div>
      </div>
      </div>
    </div>
  );
}
