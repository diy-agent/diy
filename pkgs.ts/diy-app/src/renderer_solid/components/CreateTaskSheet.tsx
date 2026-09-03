// @ts-nocheck
import { createSignal } from "solid-js";
import { createTaskViaUi } from "../lib/create-task";
import { notificationStore } from "../store/notificationStore";

export function CreateTaskSheet(props: {
    projectId: string;
    projectLabel: string;
    parentUri?: string;
    compact?: boolean;
}) {
    const [open, setOpen] = createSignal(false);
    const [title, setTitle] = createSignal("");
    const [busy, setBusy] = createSignal(false);
    const isSubtask = () => !!props.parentUri;

    const submit = async () => {
        if (!title().trim()) {
            notificationStore.addToast("error", "标题不能为空");
            return;
        }
        setBusy(true);
        try {
            await createTaskViaUi({
                title: title().trim(),
                project: props.projectId,
                parent: props.parentUri,
            });
            setOpen(false);
            setTitle("");
        } catch (e: any) {
            notificationStore.addToast("error", `创建失败: ${e.message}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <button
                class="ml-auto opacity-40 hover:opacity-100 text-xs px-1"
                onClick={(e) => {
                    e.stopPropagation();
                    setOpen(true);
                }}
            >
                ＋
            </button>

            {/* DaisyUI Modal */}
            <dialog class="modal" open={open()}>
                <div class="modal-box w-96">
                    <h3 class="font-bold text-lg">
                        {isSubtask() ? "添加子任务" : "添加任务"}
                    </h3>
                    <p class="text-xs opacity-60 py-2">
                        {isSubtask()
                            ? `添加到「${props.projectLabel}」`
                            : `为「${props.projectLabel}」创建新任务`}
                    </p>

                    <div class="form-control py-1">
                        <label class="label">
                            <span class="label-text">任务标题</span>
                        </label>
                        <input
                            class="input input-bordered input-sm"
                            placeholder="输入任务标题"
                            value={title()}
                            onInput={(e) => setTitle(e.currentTarget.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && title().trim()) submit();
                            }}
                            autofocus
                        />
                    </div>

                    <div class="modal-action">
                        <button class="btn btn-sm" onClick={() => setOpen(false)}>取消</button>
                        <button
                            class="btn btn-primary btn-sm"
                            onClick={submit}
                            disabled={busy() || !title().trim()}
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
