// insights 插件 —— **只贡献 view，不贡献页**。
//
// package.json 里只有 `contributes.views.film[0].area = "main"`：它不知道 film 页有几个区域、
// 谁是左侧栏、底栏多高 —— 那些在宿主的 three-pane-bottom 骨架里。它只说了「插进 film 的 main 槽」。
//
// theia / VS Code 里这一条就是 `"views": { "explorer": [...] }`（往别人的容器里塞）。
// 反过来，如果清单只能指向自己贡献的页，插件就永远只能长成「一个插件一整个页」——
// 那不是插件化，是把整页打包换了个人写。

import type { Scope, ViewProps } from '@diy-agent/workbench-dock';
import type { PluginManifest } from '../../registry';
import manifestJson from './package.json';

export const manifest = manifestJson as PluginManifest;

function FieldNotes({ scope }: ViewProps<Scope>) {
    return (
        <div className="wb-view">
            <div className="wb-view-head">
                <strong>场记 · {scope.title}</strong>
                <span className="wb-tag">insights</span>
            </div>
            <p className="wb-msg">
                我是 insights 插件 —— 我的 package.json 里没有 pages，只写了一行「插进 film 页的 main 槽」。 film
                是三个区域还是五个，与我无关。
            </p>
        </div>
    );
}

export const views = {
    'insights.notes': FieldNotes,
};
