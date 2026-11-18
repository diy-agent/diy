// 03-plugin —— 宿主：扫包 → 校验清单 → 渲染。
//
// 这个文件里没有一个字提到 film / notes / insights 的业务（除了 import 和 scopes 那两行数据）。
// 换一个业务，改的是 plugins/ 下的目录 —— 这就是插件化换来的东西。
//
// 宿主只做四件事：
//   ① 收集插件包（真宿主扫 node_modules / 读目录 / 从后端拿 package.json）
//   ② loadPlugins()：校验 + 拼 PageDef / ViewDef —— 清单写错在这里炸，不是运行时白屏
//   ③ **给 scope**：插件贡献「页由哪些 view 组成」，宿主决定「开哪个实例」，插件不许自己造实例
//   ④ 渲染 <PageWorkbench page views scope />，左边的 rail 自己画
//
// 这个文件里也没有骨架：骨架在 skeletons.ts，是宿主的词汇表（对应 theia 的 viewsContainers）。

import 'dockview/dist/styles/dockview.css';
import './style.css';

import { pageId, type Scope } from '@diy-agent/workbench-dock';
import { PageWorkbench } from '@diy-agent/workbench-dock/react';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as film from './plugins/film';
import * as insights from './plugins/insights';
import * as notes from './plugins/notes';
import { loadPlugins, type Contribution, type PluginPackage } from './registry';

/** ① 安装 = 出现在这个列表里。真宿主这里是扫目录 / 读配置，形状一样 */
const installed: PluginPackage[] = [
    { manifest: film.manifest, views: film.views },
    { manifest: notes.manifest, views: notes.views },
    { manifest: insights.manifest, views: insights.views },
];

// ② 加载：任何一份清单不合法，这里整批抛错（宿主启动即失败，不静默降级）
const contributions = loadPlugins(installed);

// ③ scope 由宿主给：插件不知道自己会被开成哪个实例、开几份
const scopes: Record<string, Scope> = {
    film: { kind: 'film', id: 'd-1', title: '深海' },
    notes: { kind: 'notes', id: 'n-1', title: '布局笔记' },
};

/** 坏清单 ①：插到骨架里没有的槽位 —— 「插在哪」写错了，和布局无关 */
const badSlot: PluginPackage = {
    manifest: {
        name: 'bad-slot',
        version: '0.0.0',
        diy: { apiVersion: 1 },
        contributes: { views: { film: [{ id: 'bad.x', title: '坏', area: 'nope' }] } },
    },
    views: { 'bad.x': () => null },
};

/** 坏清单 ②：清单声明了 view，代码里没有 -> 版本对不上 */
const badCode: PluginPackage = {
    manifest: {
        name: 'bad-code',
        version: '0.0.0',
        diy: { apiVersion: 1 },
        contributes: { views: { film: [{ id: 'bad.y', title: '坏', area: 'main' }] } },
    },
    views: {},
};

function App() {
    const [pageType, setPageType] = useState(contributions[0]!.page.type);
    const [error, setError] = useState<string | null>(null);
    const current = contributions.find((item) => item.page.type === pageType) ?? contributions[0]!;
    const scope = scopes[current.page.type]!;

    /** PageDef.title 可能是函数（随 scope 变）；rail 里用该页的 scope 求值 */
    const titleOf = (item: Contribution) => {
        const { title } = item.page;
        return typeof title === 'string' ? title : title(scopes[item.page.type] ?? { kind: item.page.type, id: '-' });
    };

    // 跨插件贡献了多少个 view（这个页上不属于本页作者的那些）
    const foreign = contributions.reduce(
        (sum, item) => sum + Object.values(item.sources).filter((owner) => owner !== item.pluginId).length,
        0,
    );

    const tryLoad = (extra: PluginPackage) => {
        // 校验发生在**加载**时，所以这个按钮只是把 loadPlugins 再跑一遍给你看
        try {
            loadPlugins([...installed, extra]);
            setError('坏清单竟然通过了（不该发生）');
        } catch (e) {
            setError((e as Error).message);
        }
    };

    return (
        <div className="demo-root">
            <header className="demo-head">
                <span className="demo-title">03 · page 插件化</span>
                <button onClick={() => tryLoad(badSlot)}>坏槽位</button>
                <button onClick={() => tryLoad(badCode)}>没实现</button>
                <span className="demo-note" style={error ? { color: '#f85149' } : undefined}>
                    {error ? `⛔ ${error}` : 'package.json 的 contributes = 插在哪 · index.tsx = 内容 · 骨架 = 宿主的'}
                </span>
            </header>
            <div className="demo-shell">
                <nav className="rail">
                    <div className="rail-group">页</div>
                    {contributions.map((item) => (
                        <button
                            key={item.page.type}
                            className={`rail-item ${item.page.type === current.page.type ? 'on' : ''}`}
                            onClick={() => {
                                setPageType(item.page.type);
                                setError(null);
                            }}
                        >
                            <span>{item.page.icon}</span>
                            <span>{titleOf(item)}</span>
                            <span className="rail-badge">{item.views.length}</span>
                        </button>
                    ))}
                    <div className="rail-foot">
                        右边的数字 = 该页有几个 view。
                        <br />
                        {foreign} 个来自别的插件（insights 只贡献 view，没有 pages）—— 它只写「插进 film 的 main
                        槽」，film 页长什么样它不知道。
                    </div>
                </nav>
                <main className="demo-body">
                    <PageWorkbench
                        // key = 页实例 id：换插件页 = 换一份布局
                        key={pageId(current.page.type, scope)}
                        page={current.page}
                        views={current.views}
                        scope={scope}
                        storage={localStorage}
                    />
                </main>
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
