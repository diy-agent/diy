// @ts-nocheck
import { createSignal, onMount, For } from "solid-js";
export function AppInfo() {
    const [info, setInfo] = createSignal<any>(null);
    onMount(() => {
        const diy: any = (window as any).diy;
        diy?.getAppInfo?.().then(setInfo);
    });
    return (
        <div class="p-4 max-w-xl space-y-2 text-xs font-mono">
            {!info() ? (
                <div class="opacity-60">加载中…</div>
            ) : (
                <>
                    <div class="card bg-base-100 border p-3">
                        <div class="font-bold mb-1">运行</div>
                        <Row k="端口" v={String(info().port)} />
                        <Row k="PID" v={String(info().pid)} />
                    </div>
                    <div class="card bg-base-100 border p-3">
                        <div class="font-bold mb-1">目录</div>
                        <Row k="diyHome" v={info().diyHome} />
                        <Row k="cache" v={info().cache} />
                        <Row k="userData" v={info().userData} />
                    </div>
                    <div class="card bg-base-100 border p-3">
                        <div class="font-bold mb-1">版本</div>
                        <Row k="Electron" v={info().electron} />
                        <Row k="Chrome" v={info().chrome} />
                        <Row k="Node.js" v={info().node} />
                    </div>
                    <div class="card bg-base-100 border p-3">
                        <div class="font-bold mb-1">系统</div>
                        <Row k="平台" v={info().platform} />
                        <Row k="内存" v={info().memory} />
                    </div>
                </>
            )}
        </div>
    );
}
function Row(props: any) {
    return (
        <div class="flex gap-2">
            <span class="opacity-60 w-20 shrink-0">{props.k}:</span>
            <span class="break-all">{props.v}</span>
        </div>
    );
}
