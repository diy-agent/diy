import { createSignal, onMount, Show } from "solid-js";
import { diyService } from "../lib/rpc";

export interface AppInfoData {
  port: number;
  pid: number;
  diyHome: string;
  /** 数据根的展示形式（相对真实家目录缩 `~`；临时根保持绝对路径） */
  diyHomeDisplay?: string;
  /** 当前运行代码所在 git 分支（打包/非仓库为空串） */
  branch?: string;
  cache: string;
  userData: string;
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
    return (
        <div class="p-4 max-w-xl space-y-2 text-xs font-mono">
            <Show when={failed()} fallback={
                <Show when={info()} fallback={<div class="opacity-60">加载中…</div>}>
                    {(i) => (
                        <>
                            <div class="card bg-base-100 border p-3">
                                <div class="font-bold mb-1">运行</div>
                                <Row k="端口" v={String(i().port)} />
                                <Row k="PID" v={String(i().pid)} />
                                <Row k="分支" v={i().branch || "—（非 git 仓库）"} />
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
                {(err) => <div class="p-4 text-sm text-error">获取运行信息失败：{err()}</div>}
            </Show>
        </div>
    );
}
function Row(props: { k: string; v: string }) {
    return (
        <div class="flex gap-2">
            <span class="opacity-60 w-20 shrink-0">{props.k}:</span>
            <span class="break-all">{props.v}</span>
        </div>
    );
}
