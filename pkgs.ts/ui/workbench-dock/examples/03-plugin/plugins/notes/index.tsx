// notes 插件 —— 和 film 同构，只是引用了另一个骨架（two-pane）。
//
// 两个插件放一起，是为了看出**差异只落在 package.json 的一行**：
// `"skeleton": "three-pane-bottom"` vs `"skeleton": "two-pane"`，
// 而 index.tsx 的结构（清单 + views 字典）和宿主的加载代码一个字符都不用改。
//
// 注意 notes 的槽位叫 sidebar / main —— 和 film 一样。槽位名是宿主词汇，不是各插件自己起的。

import type { Scope, ViewProps } from '@diy-agent/workbench-dock';
import type { PluginManifest } from '../../registry';
import manifestJson from './package.json';

export const manifest = manifestJson as PluginManifest;

function NoteList({ scope }: ViewProps<Scope>) {
    return (
        <div className="wb-view">
            <strong>{scope.title}</strong>
            <ul className="wb-list">
                <li>布局为什么是树</li>
                <li>骨架为什么归宿主</li>
            </ul>
        </div>
    );
}

function NoteEditor({ api }: ViewProps<Scope>) {
    return (
        <div className="wb-view">
            <div className="wb-view-head">
                <strong>骨架为什么归宿主</strong>
                <button onClick={() => api.maximizeArea('main')}>最大化</button>
                <button onClick={() => api.maximizeArea(null)}>还原</button>
            </div>
            <p className="wb-msg">
                我这份 package.json 只有 18 行，里面没有一个尺寸。宽度 / 最小宽 / 谁默认折叠 全在宿主的 two-pane 骨架里
                —— 因为那是布局，而布局是要被用户拖动、被存盘覆盖的东西。 插件声明它，等于跟存盘打架。
            </p>
        </div>
    );
}

export const views = {
    'notes.list': NoteList,
    'notes.editor': NoteEditor,
};
