// nav.ts —— 侧栏导航的插槽：壳只认注册表，不写「项目树 / 历史 / 未归属」这些具体块。
//
// 与 `surfaces/registry.tsx` 同一个原则（那里是聊天面板，这里是导航区）：**能注册的东西
// 才能被壳渲染**，壳里不出现 `if (block === 'history')`。内建的三块自己也是注册项
// （见 `nav/` 目录），所以「插件贡献的条目」和「内建条目」走的是同一条路 —— 否则那条路
// 只有插件在走，一年后没人知道它还能不能用。
//
// 每一项只做一件事：`render(context)` 返回一段节点。壳不假设它画的是什么，也不给它
// 开洞 —— 要用地址就用 `context.address`，要知道展开态就用 `context.open`。

import * as React from 'react';

import type { NavAddress } from './address';
import type { Room } from './model';

/** 来源拿到的只读上下文：壳的状态 + 壳提供的容器动作 */
export interface NavContext {
    /** 侧栏是否展开。收起态（rail，56px）只能放图标，来源自己降级 */
    open: boolean;
    /** 当前的地址 —— 判断「选中」必须用它，`selectedId` 只是 room 页上的投影 */
    address: NavAddress;
    /**
     * 壳提供的容器动作（新建项目 / 新建任务 / 请求删除，对话框归 App 所有）。
     *
     * 内建的项目树要用它们；插件来源通常用不到，忽略即可。**不要**在这里加
     * 「查询房间」之类的读能力 —— 那是 `useStore()` 的事，塞进 context 只会让这里
     * 变成一个越长越大的杂物袋。
     */
    host: NavHost;
}

export interface NavHost {
    onCreateProject(): void;
    onCreateTask(projectId: string): void;
    onRequestDelete(room: Room): void;
    /** 收起态里某些入口需要「先展开侧栏」才能继续 */
    onExpandSidebar(): void;
}

export interface NavSource {
    /** 稳定 id：重复注册时后者覆盖前者（热更新 / 插件重载的常态） */
    id: string;
    /** 排在前面的先渲染，缺省 100；内建用 10 / 20 / 30 */
    order?: number;
    render(context: NavContext): React.ReactNode;
}

const sources = new Map<string, NavSource>();
const listeners = new Set<() => void>();

/** 当前快照。`useSyncExternalStore` 要求同一版本返回同一引用，所以只在变更时重建 */
let snapshot: readonly NavSource[] = [];

const DEFAULT_ORDER = 100;

function rebuild(): void {
    snapshot = [...sources.values()].sort((a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER));
    for (const listener of listeners) listener();
}

export function registerNavSource(source: NavSource): void {
    if (source.id === '') throw new Error('NavSource.id 不能为空（它是去重键）');
    sources.set(source.id, source);
    rebuild();
}

export function unregisterNavSource(id: string): void {
    if (sources.delete(id)) rebuild();
}

/** 已注册的来源（按 order 排好）—— 测试与调试用；界面里请用 `useNavSources` */
export function navSources(): readonly NavSource[] {
    return snapshot;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * 订阅注册表。
 *
 * 为什么不是「模块加载时读一次数组」：插件可以晚于壳注册（懒加载），固定数组会让它们在
 * 注册完成之后仍然不显示，而这件事没有任何报错。
 */
export function useNavSources(): readonly NavSource[] {
    return React.useSyncExternalStore(
        subscribe,
        () => snapshot,
        () => snapshot,
    );
}
