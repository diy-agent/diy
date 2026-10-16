import { createSignal, onMount, Show } from "solid-js";
import { diyService } from "../lib/rpc";
import { notificationStore } from "../store/notificationStore";
import { tabStore } from "../store/tabStore";
import { taskStore } from "../store/taskStore";
import { debugInfoText } from "../lib/debug-info";

export interface AppInfoData {
  port: number;
  pid: number;
  diyHome: string;
  repoDisplay?: string;
  /** 数据根的展示形式（相对真实家目录缩 `~`；临时根保持绝对路径） */
  diyHomeDisplay?: string;
  /** 运行环境（production / development / test） */
  env?: string;
  /** 当前运行代码所在 git 分支（打包/非仓库为空串） */
  branch?: string;
  cache: string;
  userData: string;
  /** CDP 连接地址（`ws://...`）；未启用 CDP / serve 模式为空串 */
  cdp?: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  memory: string;
}

export function AppInfo() {
    const [info, setInfo] = createSignal<AppInfoData | null>(null);
    const [failed, setFailed] = createSignal<string | null>(null);
    onMount(() => {
        // 走 RPC router（Electron / serve / CLI 同一实现）。
        // 旧写法 window.diy?.getAppInfo?.() 在 Electron 下 window.diy 为 undefined → 静默卡死；
        // serve 下方法不存在 → TypeError 打掉 React 整棵树 → 全页白屏。
        // Solid 版加了 ?. 可选调用更糟：连 TypeError 都不抛，永久卡在「加载中…」。
        diyService.diy
            .getAppInfo({})
            .then(setInfo)
            .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)));
    });
    /** 一键复制当前 cdp / app / page 信息（供其他 agent 连接调试） */
    const copy = async () => {
        const i = info();
        if (!i) return;
        const text = debugInfoText(i, {
            active: tabStore.active,
            tabs: tabStore.opened.map((t) => ({ key: t.key })),
            selectedUri: taskStore.selectedUri,
        });
        try {
            await navigator.clipboard.writeText(text);
            notificationStore.addToast("success", "已复制调试信息（CDP / app / page）");
        } catch (e) {
            // 用户主动触发的动作：失败必须告知，不能假装成功
            console.error("[appInfo] 剪贴板写入失败：", e);
            notificationStore.addToast("error", "复制失败（剪贴板不可用）");
        }
    };
    return (
        <div class="p-4 max-w-xl space-y-2 text-body font-mono">
            <Show when={failed()} fallback={
                <Show when={info()} fallback={<div class="opacity-60">加载中…</div>}>
                    {(i) => (
                        <>
                            <div class="flex items-center gap-2">
                                <button
                                    class="btn btn-xs btn-outline"
                                    data-tip="复制 CDP attach 命令 + 本实例信息 + 当前页面，供其他 agent 连接调试"
                                    data-copy-debug
                                    onClick={() => void copy()}
                                >
                                    📋 复制调试信息
                                </button>
                                <span class="text-caption opacity-50">
                                    cdp / app / page 三段，可直接粘给另一个 agent
                                </span>
                            </div>
                            <div class="card bg-base-100 border p-3">
                                <div class="font-bold mb-1">运行</div>
                                <Row k="端口" v={String(i().port)} />
                                <Row k="PID" v={String(i().pid)} />
                                <Row k="环境" v={i().env ?? "—"} />
                                <Row k="分支" v={i().branch || "—（非 git 仓库）"} />
                            </div>
                            <div class="card bg-base-100 border p-3">
                                <div class="font-bold mb-1">调试</div>
                                <Row k="CDP" v={i().cdp || "—（未启用 / serve 模式）"} />
                            </div>
                            <div class="card bg-base-100 border p-3">
                                <div class="font-bold mb-1">目录</div>
                                <Row k="diyHome" v={i().diyHome} />
                                <Row k="diyHome（展示）" v={i().diyHomeDisplay ?? i().diyHome} />
                                <Row k="cache" v={i().cache} />
                                <Row k="userData" v={i().userData} />
                            </div>
                            <div class="card bg-base-100 border p-3">
                                <div class="font-bold mb-1">版本</div>
                                <Row k="Electron" v={i().electron} />
                                <Row k="Chrome" v={i().chrome} />
                                <Row k="Node.js" v={i().node} />
                            </div>
                            <div class="card bg-base-100 border p-3">
                                <div class="font-bold mb-1">系统</div>
                                <Row k="平台" v={i().platform} />
                                <Row k="内存" v={i().memory} />
                            </div>
                        </>
                    )}
                </Show>
            }>
                {(err) => <div class="p-4 text-prose text-error">获取运行信息失败：{err()}</div>}
            </Show>
        </div>
    );
}
function Row(props: { k: string; v: string }) {
    return (
        <div class="flex gap-2">
            <span class="opacity-60 w-24 shrink-0">{props.k}:</span>
            <span class="break-all">{props.v}</span>
        </div>
    );
}
