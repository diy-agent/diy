import { createSignal } from "solid-js";
import { createProjectViaUi } from "../lib/create-project";
import { diyService } from "../lib/rpc";
import { notificationStore } from "../store/notificationStore";

function basename(p: string) {
    const t = p.replace(/\/+$/, "");
    const i = t.lastIndexOf("/");
    return i === -1 ? t : t.slice(i + 1);
}

export function CreateProjectSheet() {
    const [open, setOpen] = createSignal(false);
    const [path, setPath] = createSignal("");
    const [label, setLabel] = createSignal("");
    const [desc, setDesc] = createSignal("");
    const [busy, setBusy] = createSignal(false);

    const pickDir = async () => {
        try {
            const r = await diyService.diy.pickProjectDirectory({});
            if (r.data.canceled || !r.data.path) return;
            setPath(r.data.path);
            if (!label().trim()) setLabel(basename(r.data.path));
        } catch {
            /* 打开选择器失败/无 Electron dialog，忽略 */
        }
    };

    const submit = async () => {
        if (!path().trim()) {
            notificationStore.addToast("error", "请先选择项目目录");
            return;
        }
        setBusy(true);
        try {
            await createProjectViaUi(path().trim(), label().trim() || undefined, desc().trim() || undefined);
            setOpen(false);
            setPath(""); setLabel(""); setDesc("");
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            notificationStore.addToast("error", `创建失败: ${msg}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <button class="btn btn-outline btn-sm" onClick={() => setOpen(true)}>
                ➕ 创建项目
            </button>

            {/* DaisyUI Modal */}
            <dialog class="modal" open={open()}>
                <div class="modal-box w-96">
                    <h3 class="font-bold text-lg">创建项目</h3>
                    <p class="text-xs opacity-60 py-2">
                        选择要映射的目录（会在其中写 diy.yaml 名片）
                    </p>

                    <div class="form-control py-1">
                        <label class="label">
                            <span class="label-text">项目目录</span>
                        </label>
                        <div class="join">
                            <input
                                class="input input-bordered input-sm join-item flex-1"
                                readonly
                                placeholder="未选择"
                                value={path()}
                            />
                            <button class="btn btn-outline btn-sm join-item" onClick={pickDir}>
                                📂 选择
                            </button>
                        </div>
                    </div>

                    <div class="form-control py-1">
                        <label class="label">
                            <span class="label-text">显示名称</span>
                        </label>
                        <input
                            class="input input-bordered input-sm"
                            placeholder="缺省取目录名"
                            value={label()}
                            onInput={(e) => setLabel(e.currentTarget.value)}
                        />
                    </div>

                    <div class="form-control py-1">
                        <label class="label">
                            <span class="label-text">描述（可选）</span>
                        </label>
                        <input
                            class="input input-bordered input-sm"
                            placeholder="项目描述"
                            value={desc()}
                            onInput={(e) => setDesc(e.currentTarget.value)}
                        />
                    </div>

                    <div class="modal-action">
                        <button class="btn btn-sm" onClick={() => setOpen(false)}>取消</button>
                        <button
                            class="btn btn-primary btn-sm"
                            onClick={submit}
                            disabled={busy() || !path().trim()}
                        >
                            {busy() ? "创建中…" : "创建"}
                        </button>
                    </div>
                </div>
                <form method="dialog" class="modal-backdrop">
                    <button onClick={() => setOpen(false)}>close</button>
                </form>
            </dialog>
        </>
    );
}
