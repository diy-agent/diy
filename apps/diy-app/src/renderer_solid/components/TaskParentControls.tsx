/**
 * TaskParentControls — 改任务的**父子关系**的两个入口（##356 ①，同文件因为同一目的）：
 *
 *   · TaskAddMenu      — 任务树行内「＋」的**层级菜单**：新建子任务 / 添加已有任务为子任务
 *   · TaskParentEditor — 任务详情里的「父级」行：显示当前父 + 一键**重设父节点**
 *
 * 需求原文：①「任务详情里能直接重设父节点（现在只能拖动，任务多了无法同屏定位 2 个节点）」
 * ②「任务管理的 + 按钮改为层级按钮，弹出『新建子任务 / 添加已有任务为子任务』两个菜单」。
 *
 * 三条路径最终都落到同一个 RPC：`diy.task.move`（新建走 createTask），校验（父存在 / 同项目 /
 * 防环）全在 main 的 updateTask —— 客户端只做体验层拦截（把必然非法的候选灰掉）。
 * 改完一律 `taskStore.loadTree()`：树刷新后 nav 的缩进/顺序也随之重算（##159 那条链路），
 * 任务表的展开态由 TaskTree 的行缓存保住（不重建 DOM）。
 */
import { createSignal, Show } from "solid-js";
import { CreateTaskDialog } from "./CreateTaskSheet";
import { TaskParentPicker } from "./TaskParentPicker";
import { diyService } from "../lib/rpc";
import { taskStore } from "../store/taskStore";
import { notificationStore } from "../store/notificationStore";

export function TaskAddMenu(props: {
    projectId: string;
    projectLabel: string;
    /** 本行任务：新建的子任务 / 选中的已有任务都挂到它下面 */
    parentUri: string;
}) {
    const [menuOpen, setMenuOpen] = createSignal(false);
    const [createOpen, setCreateOpen] = createSignal(false);
    const [pickOpen, setPickOpen] = createSignal(false);

    const moveUnder = async (childUri: string) => {
        try {
            await diyService.diy.task.move({ uri: childUri, parent: props.parentUri });
            await taskStore.loadTree();
            notificationStore.addToastLegacy("success", "已添加为子任务");
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            notificationStore.addToastLegacy("error", `添加失败: ${msg}`);
        } finally {
            setPickOpen(false);
        }
    };

    return (
        <span class="relative inline-flex" onClick={(e) => e.stopPropagation()}>
            <button
                class="opacity-40 hover:opacity-100 text-body px-1"
                title="添加子任务"
                data-testid="task-add-menu-button"
                onClick={() => setMenuOpen((p) => !p)}
            >
                ＋
            </button>
            <Show when={menuOpen()}>
                <ul
                    class="menu absolute left-0 top-full z-50 mt-1 w-56 rounded-box border border-base-300 bg-base-100 p-1 shadow-lg"
                    data-testid="task-add-menu"
                    onClick={() => setMenuOpen(false)}
                >
                    <li>
                        <button class="text-body" data-testid="task-add-menu-new" onClick={() => setCreateOpen(true)}>
                            ➕ 新建子任务
                        </button>
                    </li>
                    <li>
                        <button
                            class="text-body"
                            data-testid="task-add-menu-existing"
                            onClick={() => setPickOpen(true)}
                        >
                            🔗 添加已有任务为子任务
                        </button>
                    </li>
                </ul>
            </Show>

            <CreateTaskDialog
                open={createOpen()}
                onClose={() => setCreateOpen(false)}
                projectId={props.projectId}
                projectLabel={props.projectLabel}
                parentUri={props.parentUri}
            />
            <TaskParentPicker
                open={pickOpen()}
                onClose={() => setPickOpen(false)}
                title="选择要添加为子任务的任务"
                project={props.projectId}
                excludeSubtreeOf={props.parentUri}
                onPick={(uri) => void moveUnder(uri)}
            />
        </span>
    );
}

export function TaskParentEditor(props: { uri: string; project: string; parentTitle: string | null }) {
    const [open, setOpen] = createSignal(false);

    const moveUnder = async (parent: string) => {
        try {
            await diyService.diy.task.move({ uri: props.uri, parent });
            await taskStore.loadTree();
            notificationStore.addToastLegacy("success", parent ? "已重设父节点" : "已提升为一级任务");
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            notificationStore.addToastLegacy("error", `重设失败: ${msg}`);
        } finally {
            setOpen(false);
        }
    };

    return (
        <>
            <div class="task-field-row">
                <span class="task-field-label text-body opacity-50">父级</span>
                <span class="min-w-0 truncate flex-1 opacity-80" title={props.parentTitle ?? "（无）一级任务"}>
                    {props.parentTitle ?? "（无）一级任务"}
                </span>
                <button
                    class="btn btn-ghost btn-xs shrink-0 opacity-60 hover:opacity-100"
                    title="重设父节点"
                    data-testid="task-parent-edit"
                    onClick={() => setOpen(true)}
                >
                    ✏️
                </button>
            </div>
            <TaskParentPicker
                open={open()}
                onClose={() => setOpen(false)}
                title="重设父节点"
                project={props.project}
                excludeSubtreeOf={props.uri}
                allowRoot
                onPick={(uri) => void moveUnder(uri)}
            />
        </>
    );
}
