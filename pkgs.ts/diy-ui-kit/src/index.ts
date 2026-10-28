// @diy/ui-kit — 纯展示组件与纯工具的**唯一出口**。
//
// 判据（##448）：不 import 任何 `store/*`、不 import `lib/rpc`、props 进 DOM 出；
// `dependencies` 只允许 `solid-js`（不含 `@diy/*`、不含三方渲染库）。
// 加新组件前先核这三条 —— 带全局状态（theme / ui-state）或三方依赖的一律不进本包。
export { ChatGlyph, type ChatGlyphTone } from "./ChatGlyph";
export { ChatSkinPreview, SKIN_PREVIEW_HOOKS } from "./ChatSkinPreview";
export { ConfirmDialog } from "./ConfirmDialog";
export { DeleteEntryButton } from "./DeleteEntryButton";
export { DrawerMaxButton, useDrawerMax, type DrawerMax } from "./DrawerMaximize";
export { DynamicBar } from "./DynamicBar";
export { RowGutter } from "./RowGutter";
export { ViewBoundary } from "./ViewBoundary";
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
} from "./icons";
export { fmtBytes } from "./bytes";
export { Z_CHAT_FIND, Z_FIND, Z_TOAST } from "./z-layers";
