// nav/index.ts —— 内建来源的注册入口（由 Sidebar 在模块加载时调用一次）。
//
// 单独一层是为了「注册」这件事只发生在一个地方：将来别的包要往侧栏塞东西，走的是
// `registerNavSource`（同一个函数），不需要知道内建三块在哪个文件。

import { registerNavSource } from '../nav';
import { historySource } from './history';
import { orphansSource } from './orphans';
import { projectsSource } from './projects';

let registered = false;

/** 幂等：热更新会重复执行模块，重复注册同一个 id 只是覆盖（`registerNavSource` 的语义） */
export function registerBuiltinNav(): void {
    if (registered) return;
    registered = true;
    registerNavSource(projectsSource);
    registerNavSource(historySource);
    registerNavSource(orphansSource);
}
