import { createSignal } from "solid-js";
import { createTaskViaUi } from "../lib/create-task";
import { notificationStore } from "../store/notificationStore";
import { onEnterKey } from "../lib/on-enter";

/**
 * 新建任务对话框（**受控、无触发器**）。
 *
 * 从 CreateTaskSheet 拆出来是为了让「触发器」与「对话框」解耦（##356 ①）：
 * 行内 ＋ 已改成**层级菜单**（新建子任务 / 添加已有任务为子任务），菜单项要直接开
 * 「新建子任务」这一档 —— 若对话框仍和那个 ＋ 按钮焊在一起，菜单项就得去点一个
 * 看不见的按钮。受控版本让调用方自己决定什么时候开。
 */
export function CreateTaskDialog(props: {
    open: boolean;
    onClose: () => void;
    projectId: string;
    projectLabel: string;
    parentUri?: string;
}) {
    const [title, setTitle] = createSignal("");
    const [busy, setBusy] = createSignal(false);
    const isSubtask = () => !!props.parentUri;

    const submit = async () => {
        if (!title().trim()) {
            notificationStore.addToastLegacy("error", "标题不能为空");
            return;
        }
        setBusy(true);
        try {
            await createTaskViaUi({
                title: title().trim(),
                project: props.projectId,
                parent: props.parentUri,
            });
            props.onClose();
            setTitle("");
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            notificationStore.addToastLegacy("error", `创建失败: ${msg}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <dialog class="modal" open={props.open}>
            <div class="modal-box w-96">
                <h3 class="font-bold text-display">
                    {isSubtask() ? "添加子任务" : "添加任务"}
                </h3>
                <p class="text-body opacity-60 py-2">
                    {isSubtask()
                        ? `添加到「${props.projectLabel}」`
                        : `为「${props.projectLabel}」创建新任务`}
                </p>

                <div class="form-control py-1">
                    <label class="label">
                        <span class="label-text text-body">任务标题</span>
                    </label>
                    <input
                        class="input input-bordered input-sm"
                        placeholder="输入任务标题"
                        value={title()}
                        onInput={(e) => setTitle(e.currentTarget.value)}
                        onKeyDown={onEnterKey(() => { if (title().trim()) submit(); })}
                        autofocus
                    />
                </div>

                <div class="modal-action">
                    <button class="btn btn-sm" onClick={props.onClose}>取消</button>
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
                <button class="text-body" onClick={props.onClose}>close</button>
            </form>
        </dialog>
    );
}

/** 自管开关的「＋」入口（项目行用：项目下没有父子语义，直接新建一级任务） */
export function CreateTaskSheet(props: {
    projectId: string;
    projectLabel: string;
    parentUri?: string;
    compact?: boolean;
}) {
    const [open, setOpen] = createSignal(false);

    return (
        <>
            <button
                class="ml-auto opacity-40 hover:opacity-100 text-body px-1"
                onClick={(e) => {
                    e.stopPropagation();
                    setOpen(true);
                }}
            >
                ＋
            </button>
            <CreateTaskDialog
                open={open()}
                onClose={() => setOpen(false)}
                projectId={props.projectId}
                projectLabel={props.projectLabel}
                parentUri={props.parentUri}
            />
        </>
    );
}
