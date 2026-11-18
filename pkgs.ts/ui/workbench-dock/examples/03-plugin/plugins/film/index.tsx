// film 插件 —— 代码部分：**只导出 view 的实现，不导出任何布局信息**。
//
// 它在 package.json 里说了四件事：「我要一个 film 页，用宿主的 three-pane-bottom 骨架」+ 每个 view
// 插进哪个槽。槽是 sidebar / main / aside / bottom —— 名字和大小都由宿主定义，插件作者连
// 「左边 240px」都不知道。
//
// 插件作者的三条纪律（宿主不替你兜）：
//   1. 组件不许碰 dockview：要开合区域就用 api（或深层子组件里的 usePageApi()）
//   2. 组件不许假设自己独占一个区域（同一个 view 可以被不同页用到不同槽）
//   3. 数据从哪来是插件自己的事（这里全是写死的示意数据）

import type { Scope, ViewProps } from '@diy-agent/workbench-dock';
import type { PluginManifest } from '../../registry';
import manifestJson from './package.json';

/** 清单原样保留（宿主只读不执行）；断言是因为 JSON 推断不出 `apiVersion: 1` 这种字面量 */
export const manifest = manifestJson as PluginManifest;

function Live({ scope, api }: ViewProps<Scope>) {
    return (
        <div className="wb-view">
            <div className="wb-view-head">
                <strong>🎬 {scope.title}</strong>
                <span className="wb-tag">4 机位</span>
                <button onClick={() => api.toggleArea('aside')}>道具</button>
            </div>
            <p className="wb-msg">
                这个槽在清单里标了 primary（= main 槽的默认 tab）—— 组件不知道，也不需要知道。 它只认得
                api.toggleArea('aside') 这个**槽位名**。
            </p>
        </div>
    );
}

function Shots() {
    return (
        <div className="wb-view">
            <ol className="wb-list">
                <li>海面俯拍</li>
                <li>潜航器入水</li>
            </ol>
        </div>
    );
}

function Props({ api }: ViewProps<Scope>) {
    return (
        <div className="wb-view">
            <ul className="wb-list">
                <li>潜航器 ×1</li>
                <li>灯架 ×2</li>
            </ul>
            <button onClick={() => api.hideArea('aside')}>收起本区域</button>
        </div>
    );
}

function Timeline() {
    return (
        <div className="wb-hint">
            底栏横跨上面三列 —— 那是宿主 three-pane-bottom 骨架给的，我只说了 area: "bottom"。
        </div>
    );
}

/** key = 清单里的 view id：少了宿主报「声明了但没实现」，多了不会自动出现 */
export const views = {
    'film.live': Live,
    'film.shots': Shots,
    'film.props': Props,
    'film.timeline': Timeline,
};
