// components/ChatSkinPreview.tsx — 外观设置里的**皮肤实时小样**
//
// 为什么要它：设置页会**整体顶掉主内容区**（聊天区此时不在 DOM）⇒ 在外观里点"竖栏/卡片"，
// 屏幕上没有任何东西会变 —— 用户只能看到按钮 active 变了下，必然得出"样式设置无效"的结论
// （2026-10-12 实测复现：切皮肤时 `document.querySelectorAll('.diy-chat').length === 0`）。
// 小样把 agent 输出区的一小段搬进设置页 ⇒ 切换所见即所得，且**零逻辑**：样式规则全靠
// index.css 的 `[data-skin]` 段（`data-skin` 挂在 documentElement 上，切换即全局生效）。
//
// 硬约束：钩子必须与真实 DOM 一致（**含嵌套关系**），否则小样会"撒谎"（显示的差异不是真差异）。
//   · 每个行 = `[data-block-id]` 那个块**自己**（卡/行本体 + 行首折叠条列），见 RowGutter.tsx
//   · `[data-row-band]` 里**嵌** `[data-row-handle]` → 一根条、一个点击区（整块高 + 图标首行居中）
//   · `data-testid="turn-header"` → LocalChatPage 的 TurnHeader（`data-block-tag="turn"`：不是卡）
//   · `data-block-tag="proc-bar"` → 过程 bar（**子层容器在卡内**，位移由父卡留白给）
//   · `data-proc-children` → 过程 bar 铺开后的子层容器（card 不另给位移、rail 给线+缩进）
//   · `data-tail-box`（+ `data-failing`）/ `data-block-tag="proc-bar"[data-has-error]` → 结尾槽与出错态
//   · `data-chat-list` → **每轮的过程历史容器**（rail 那条贯穿线的作用点；结尾槽与状态行在它之外）
//   · `data-turn-status` → 状态行（末行恒显，两皮肤同一形态：上虚线 + 纯文本，不卡片化）
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
  'data-row-head',
  'data-row-band',
  'data-row-handle',
  'data-proc-children',
] as const;

/**
 * 竖列折叠条的**小样**：与真实组件同结构（条里嵌图标）。
 * 形状/位置全交给 `[data-row-band]` / `[data-row-handle]` 规则 —— 小样自己不带任何定位样式。
 */
function Gutter(props: { open?: boolean; can?: boolean }) {
  const can = props.can !== false;
  return (
    <span class="diy-row-band" data-row-band={can ? "1" : "static"} aria-hidden="true">
      <span class="diy-row-handle" data-row-handle={can ? "1" : "static"} aria-hidden="true">
        {can ? (props.open ? "▾" : "▸") : "·"}
      </span>
    </span>
  );
}

/** 过程行（think / tool）：块 + 条 + 行头（与 LocalChatPage.ProcessRow 同形状） */
function ProcRow(props: { tag: string; open?: boolean; text: string; id: string }) {
  return (
    <div data-block-tag={props.tag} data-block-id={props.id} data-expandable="1">
      <Gutter open={props.open} />
      <div class="flex w-full items-center gap-1.5 py-1.5" role="button" tabindex="-1" data-row-head="1">
        <span class="truncate opacity-80">{props.text}</span>
      </div>
    </div>
  );
}

export function ChatSkinPreview() {
  return (
    <div class="diy-chat space-y-1.5 rounded-lg border border-base-300/70 bg-base-100/50 p-2" data-testid="skin-preview">
      <div class="px-0.5 pb-0.5 text-caption opacity-50">小样（切换即时生效；与真实输出同一套规则）</div>
      {/* 块树列 = rail 那条贯穿线的作用点（真实聊天页同钩子，见 LocalChatPage 的块树列） */}
      <div class="space-y-1.5" data-chat-list>
        {/* 人物栏：一级标题行 —— 不是卡（`data-block-tag="turn"`），开合手柄在行首折叠条列 */}
        <div
          class="flex w-full items-center gap-1.5 py-1 text-left text-body"
          data-testid="turn-header"
          data-block-tag="turn"
          data-block-id="skin-preview-turn"
          data-row-head="1"
        >
          <Gutter open />
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
        {/* 过程 bar（铺开）：卡 = 块自己，**子层在卡内**（子行缩进在父卡留白里）；
             card 的子卡色条浅一档、无竖线，rail 的子层容器带细线 + 缩进 */}
        <div data-block-tag="proc-bar" data-block-id="skin-preview-proc">
          <Gutter open />
          <div
            class="flex w-full items-center gap-1.5 py-1 text-body"
            role="button"
            tabindex="-1"
            data-row-head="1"
          >
            <span class="shrink-0 rounded bg-base-300/60 px-1 text-caption tabular-nums opacity-70">💭 3 · ⚙ 5</span>
            <span class="truncate opacity-60">│ 先确认一下目录结构</span>
          </div>
          <div class="space-y-0.5" data-proc-children="1">
            <ProcRow tag="think" id="skin-preview-child-1" text="💭 先确认一下目录结构" />
            <ProcRow tag="tool" open id="skin-preview-child-2" text="⚙ bash · rg -c TODO a.ts" />
          </div>
        </div>
        {/* 一顿出错的过程 bar：只有错误/警告吃色（判据两皮肤一致） */}
        <div data-block-tag="proc-bar" data-block-id="skin-preview-proc-err" data-has-error="1">
          <Gutter open />
          <div class="flex w-full items-center gap-1.5 py-1 text-body" role="button" tabindex="-1" data-row-head="1">
            <span class="shrink-0 rounded bg-base-300/60 px-1 text-caption tabular-nums opacity-70">💭 0 · ⚙ 2</span>
            <span class="truncate text-error">工具出错</span>
          </div>
        </div>
        {/* 过程历史里的正文行（与结尾槽的结论同组件：行数超阈值时可折，点它折的是它自己） */}
        <div data-block-tag="text" data-block-id="skin-preview-text">
          <Gutter open />
          <div class="text-base-content/80">历史里的一段正文……</div>
        </div>
      </div>
      {/* 结尾槽（结论）：**在历史容器之外** —— 它自己就是那块（恒显、与状态同级），rail 的线不穿过它 */}
      <div data-block-id="skin-preview-conc" data-block-tag="text" data-tail-box="conclusion">
        <Gutter open />
        <div class="text-base-content/80">这轮的结论……</div>
      </div>
      {/* 结尾槽（结束点：completed 但末件是工具）—— 保持工具形态 + tag，不冒充结论 */}
      <div data-block-id="skin-preview-endleaf" data-block-tag="tool" data-tail-box="endleaf">
        <Gutter />
        <div class="flex items-center gap-1.5 py-1.5" data-row-head="1">
          <span class="truncate text-base-content/80">⚙ rg -c TODO a.ts</span>
          <span class="shrink-0 rounded border border-dashed border-base-300 px-1 text-caption opacity-50">
            本轮结束点
          </span>
        </div>
      </div>
      {/* 结尾槽（失败现场）：框原地转红 —— 只有错误/警告吃色 */}
      <div data-block-id="skin-preview-scene" data-block-tag="error" data-tail-box="scene" data-failing="1">
        <Gutter open />
        <div class="flex items-center gap-1.5 py-1.5" data-row-head="1">
          <span class="text-error">✗ 出错现场</span>
        </div>
      </div>
      {/* 状态行（末行恒显）：两皮肤同一形态 —— 上虚线 + 纯文本，✓/✗/⛔ 扛状态色；
          折叠条列恒给一个静态点（草图 `.k-status` 的 `gut static`），左列才是齐的一列 */}
      <div class="flex items-center gap-2 text-body" data-turn-status="1">
        <Gutter can={false} />
        <span class="text-success">✓</span>
        <span class="opacity-50">2026-10-12 10:24:07</span>
        <span class="flex-1" />
        <span class="opacity-70">3 步 · 12 秒 · ⚙ 2</span>
        <span class="rounded bg-base-300/60 px-1 text-caption opacity-70">⚡ 38 tok/s</span>
      </div>
    </div>
  );
}
