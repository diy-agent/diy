// page.ts — 页面贡献的公共形状。
//
// 外壳（本包）与页面插件之间**只**通过这些字段说话：id / title / methods。
// 外壳不知道页面是聊天、编辑器还是别的什么 —— 加页面只需多一份插件，不改本包。

/** 侧栏与顶栏显示用的最小身份 */
export interface PageInfo {
    readonly id: string;
    readonly title: string;
}

/** 页面在主进程侧的一个方法：参数原样来自 renderer，返回值必须能被结构化克隆 */
export type PageMethod = (args: unknown) => unknown | Promise<unknown>;

/** 一个插件向工作台交付的页面 */
export interface PageContribution extends PageInfo {
    /** 方法表；`page:invoke` 按 method 名查这里 */
    readonly methods?: Readonly<Record<string, PageMethod>>;
}
