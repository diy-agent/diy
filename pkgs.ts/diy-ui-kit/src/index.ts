// @diy-agent/ui-kit — 纯展示组件与纯工具的**唯一出口**。
//
// 判据（##448）：不 import 任何 `store/*`、不 import `lib/rpc`、props 进 DOM 出；
// `dependencies` 只允许 `solid-js`（不含 `@diy-agent/*`、不含三方渲染库）。
// 加新组件前先核这三条 —— 带全局状态（theme / ui-state）或三方依赖的一律不进本包。
export { ChatGlyph, type ChatGlyphTone } from "./ChatGlyph.js";
export { ChatSkinPreview, SKIN_PREVIEW_HOOKS } from "./ChatSkinPreview.js";
export { ConfirmDialog } from "./ConfirmDialog.js";
export { DeleteEntryButton } from "./DeleteEntryButton.js";
export { DrawerMaxButton, useDrawerMax, type DrawerMax } from "./DrawerMaximize.js";
export { DynamicBar } from "./DynamicBar.js";
export { RowGutter } from "./RowGutter.js";
export { ViewBoundary } from "./ViewBoundary.js";
export {
    IconBolt,
    IconChevron,
    IconClock,
    IconCode,
    IconCollapse,
    IconCompress,
    IconDot,
    IconExpand,
    IconGrip,
    IconTrash,
} from "./icons.js";
export { fmtBytes } from "./bytes.js";
export { Z_CHAT_FIND, Z_FIND, Z_TOAST } from "./z-layers.js";
