// nav/index.ts —— 内建来源的注册入口（由 Sidebar 在模块加载时调用一次）。
//
// 单独一层是为了「注册」这件事只发生在一个地方：将来别的包要往侧栏塞东西，走的是
// `registerNavSource`（同一个函数），不需要知道内建四块（置顶 / 项目 / 历史 / 未归属）在哪个文件。

import { registerNavSource } from '../nav';
import { historySource } from './history';
import { orphansSource } from './orphans';
import { pinnedSource } from './pinned';
import { projectsSource } from './projects';

let registered = false;

/** 幂等：热更新会重复执行模块，重复注册同一个 id 只是覆盖（`registerNavSource` 的语义） */
export function registerBuiltinNav(): void {
    if (registered) return;
    registered = true;
    // order 决定上下：置顶（5）→ 项目树（10）→ 历史（20）→ 未归属（30）
    registerNavSource(pinnedSource);
    registerNavSource(projectsSource);
    registerNavSource(historySource);
    registerNavSource(orphansSource);
}
