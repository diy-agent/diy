import { createSignal, onMount, Show } from "solid-js";

export interface AppInfoData {
  port: number;
  pid: number;
  diyHome: string;
  cache: string;
  userData: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  memory: string;
}

declare global {
  interface Window {
    diy?: {
      getAppInfo?: () => Promise<AppInfoData>;
    };
  }
}

export function AppInfo() {
    const [info, setInfo] = createSignal<AppInfoData | null>(null);
    onMount(() => {
        window.diy?.getAppInfo?.().then(setInfo);
    });
    return (
        <div class="p-4 max-w-xl space-y-2 text-xs font-mono">
            <Show when={info()} fallback={<div class="opacity-60">加载中…</div>}>
                {(i) => (
                    <>
                        <div class="card bg-base-100 border p-3">
                            <div class="font-bold mb-1">运行</div>
                            <Row k="端口" v={String(i().port)} />
                            <Row k="PID" v={String(i().pid)} />
                        </div>
                        <div class="card bg-base-100 border p-3">
                            <div class="font-bold mb-1">目录</div>
                            <Row k="diyHome" v={i().diyHome} />
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
