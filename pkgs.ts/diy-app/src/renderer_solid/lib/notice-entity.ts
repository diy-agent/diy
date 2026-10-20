/**
 * notice-entity.ts — 「任务 / 项目 / 草稿」这类**写操作**提示的二级信息（##391 R4 ④）。
 *
 * 为什么"成功"也要说机制：用户看到的是一句「已删除任务」，但真正需要知道的是
 * **不可恢复**、**子任务没被删**（失父升为一级）、**树已重载** —— 这三件事决定了下一步该做什么。
 * 只给结论的成功提示 = 让用户自己猜发生了什么（本任务要根治的病）。
 *
 * 口径来源（写文案前逐条查过实现，别凭印象改）：
 *   · 删任务：main 只 `rmSync` 该任务目录；子任务目录并列，父关系由 frontmatter 表达
 *     → 子任务**不会被删**，只是失父升为一级任务。删除**不可恢复**。
 *   · 删项目：摘名片 + 删数据目录，**连带其下全部任务**，不可恢复。
 *   · 状态改动：`ui.task.setState` 只改 frontmatter 的 state，随后重载树。
 *   · 草稿：输入停键后防抖落盘（按 taskUri 分槽），失败**不回滚内存**、下轮输入会重试；
 *     为避免刷屏，失败提示有节流（同一条错误不会每秒弹一次）。
 */
import type { NoticeMeta } from "./notice";

const DETAIL_TASK_DELETE = [
    "在监测什么：删除任务 = 删掉该任务**自己的目录**（`projects/<pid>/tasks/<tid>/`），然后重载任务树。",
    "子任务会怎样：**不会被删**。父子关系由 frontmatter 的 `parent` 字段表达（不看目录嵌套），父任务没了就落回顶层、成为一级任务。",
    "为什么不可恢复：这是 `rmSync`，没有回收站（确实需要保留的话，先在任务 body 里存一份要点）。",
    "怎么消：4 秒自动消失；删除失败会另出一条 error 提示（那条同样带详情）。",
].join("\n");

const DETAIL_PROJECT_DELETE = [
    "在监测什么：删除项目 = 摘掉项目名片 + 删掉整个数据目录（`projects/<pid>/`），随后重载任务树。",
    "会连带什么：该项目下**全部任务与会话日志**一并删除（它们是子目录）—— 这是与「删任务」最大的区别。",
    "为什么不可恢复：同样是直接删目录，没有回收站。",
    "怎么消：4 秒自动消失；失败另出 error 提示。",
].join("\n");

const DETAIL_TASK_CREATE = [
    "在监测什么：新建任务 = 写任务目录 + frontmatter（标题 / 项目 / 父任务 / 变更性质 / 模块 / 优先级），然后重载任务树。",
    "为什么会弹：新任务在树里的位置取决于 `parent` 与排序规则，不看这行字你可能会去找「它到底建到哪去了」。",
    "对你的影响：任务 body 若为内联文本，会原样写进任务文件正文（新建不带 frontmatter，传整份带头的文件会把头写进正文）。",
    "怎么消：4 秒自动消失；创建失败会另出 error（不静默）。",
].join("\n");

const DETAIL_PROJECT_CREATE = [
    "在监测什么：新建项目 = 在数据根下建 `projects/<pid>/` 并写项目名片（路径 / 标签 / 描述）。",
    "为什么会弹：项目是任务的**归属容器**，新建后通常紧接着要建任务 —— 提示里的 `#id` 就是后续命令/URI 要用的那个号。",
    "对你的影响：项目目录即数据落点（任务与会话日志都写在它下面）；路径写错的话后续任务会建在别处。",
    "怎么消：4 秒自动消失；创建失败会另出 error（不静默）。",
].join("\n");

const DETAIL_STATE = [
    "在监测什么：直接改任务的 `state` 字段（todo / active / done…），改完重载任务树。",
    "为什么会弹：这是**写盘**动作 —— 树上的徽标会立刻变，但真正生效的是任务文件里的 frontmatter；提示是让你确认「改的是哪一条、改成了什么」。",
    "对你的影响：改状态不影响任务正文与会话；若树没变（文件被别的实例改了），重载后以盘上为准。",
    "怎么消：4 秒自动消失；失败会另出 error 提示。",
].join("\n");

const DETAIL_DRAFT = [
    "在监测什么：输入框内容的**防抖落盘**（每个 taskUri 一个草稿槽，停键后写盘）。",
    "为什么会弹：草稿是你还没发出去的内容 —— 写盘失败意味着这些字此刻只在内存里，切走/崩溃就没了。失败**不会**回滚内存（本进程内还看得见），下次输入会自动重试。",
    "为什么只弹一次：同一段错误有节流（否则输入一次弹一次，等于把真正的错误淹掉）。",
    "怎么消：4 秒自动消失；控制台有原始错误（`[draftStore]` 前缀）与 task 标识。",
].join("\n");

/** 删任务（不可恢复 + 子任务失父升一级） */
export function taskDeletedNotice(title?: string): NoticeMeta {
    return {
        source: "任务树 · deleteTask（renderer_solid/lib/delete-entry.ts::deleteTaskViaUi）",
        reason: title ? `已删除任务「${title}」并重载任务树；其子任务未被删除，已失父升为一级任务` : "已删除任务并重载任务树；其子任务未被删除，已失父升为一级任务",
        detail: DETAIL_TASK_DELETE,
    };
}

/** 删项目（连带其下全部任务） */
export function projectRemovedNotice(p: { id: string; label?: string }): NoticeMeta {
    return {
        source: "任务树 · removeProject（renderer_solid/lib/delete-entry.ts::removeProjectViaUi）",
        reason: `已删除项目${p.label ? `「${p.label}」` : ` #${p.id}`}及其下全部任务与会话日志，并重载任务树`,
        detail: DETAIL_PROJECT_DELETE,
    };
}

/** 新建任务 */
export function taskCreatedNotice(p: { uri: string; parent?: string | null; project?: string }): NoticeMeta {
    return {
        source: "任务树 · createTask（renderer_solid/lib/create-task.ts::createTaskViaUi）",
        reason: `已创建${p.parent ? `子任务（父 ${p.parent}）` : "一级任务"} ${p.uri}${p.project ? `，项目 ${p.project}` : ""}；任务树已重载`,
        detail: DETAIL_TASK_CREATE,
    };
}

/** 新建项目 */
export function projectCreatedNotice(p: { id: string; path?: string; label?: string }): NoticeMeta {
    return {
        source: "任务树 · createProject（renderer_solid/lib/create-project.ts::createProjectViaUi）",
        reason: `已创建项目 #${p.id}${p.label ? `「${p.label}」` : ""}${p.path ? `，数据目录 ${p.path}` : ""}；项目列表已重载`,
        detail: DETAIL_PROJECT_CREATE,
    };
}

/** 改任务状态 */
export function taskStateNotice(p: { uri: string; state: string }): NoticeMeta {
    return {
        source: "任务树 · ui.task.setState（renderer_solid/lib/renderer-api-impl.ts）",
        reason: `任务 ${p.uri} 的 state 已写为 ${p.state}（frontmatter 已落盘），任务树已重载`,
        detail: DETAIL_STATE,
    };
}

/** 草稿落盘失败 */
export function draftFailedNotice(p: { uri: string; error: unknown }): NoticeMeta {
    const msg = p.error instanceof Error ? p.error.message : String(p.error);
    return {
        source: "输入草稿 · draftStore（renderer_solid/store/draftStore.ts::reportError）",
        reason: `会话 ${p.uri} 的草稿写盘失败（${msg || "(无错误消息)"}）→ 内容仍在内存、未丢；下次输入会自动重试`,
        detail: DETAIL_DRAFT,
    };
}
