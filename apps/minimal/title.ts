// title.ts — 窗口标题（主进程与 renderer 共用）。
//
// 单独成文件是为了让 renderer **不必** import profile（index.ts）：profile 里有插件模块的
// 真 import（主进程侧，含 Node 依赖），拖进 renderer bundle 会炸；标题是唯一共用的值。

export const TITLE = "最小工作台（假模型）";
