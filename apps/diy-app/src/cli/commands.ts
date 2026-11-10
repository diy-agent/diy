/**
 * cli/commands.ts —— 命令面声明的**唯一汇总表**（##518 命令面整理）
 *
 * 与 `main/services/api-domains/*` 的分工：
 *   · `api-domains/<域>/api.ts`  说「有哪些方法、参数是什么」（协议真源）；
 *   · 本文件说「用户**敲什么**」（命令面真源）：别名、弃用、将来的分组。
 *
 * 为什么单独成文件而不是散在 index.ts 里：命令面是**产品决策**（动词统一成 ls/run/build…），
 * 协议是**工程契约**，两者改动节奏不同。放在一处，改命名时不用碰 rpc。
 *
 * 现状（第一步，只加不删）：给列表类方法加 `ls` 别名；旧名保留。
 * 下一步：把 `deprecated` 填上后，让 `-h` 只列新名（别名目标目前仍是方法原名，见 TODO）。
 */

/** 用户可敲的**别名**（键 = 用户敲的命令段；值 = 现有命令段） */
export const CLI_ALIASES: Record<string, string> = {
    // 列表类一律 ls（各域的 list/query/snapshot 是协议名，不是用户词汇）
    "task list": "task task", // TODO(##518): 待 task 域的 list 路由确认后改成 "task ls" 指向它
    "traffic ls": "traffic query",
    "job ls": "job list",
    "instances ls": "instances ls", // 已是 ls，占位示例：别名表允许自指（等价于无别名）
};

/** 弃用：老命令 → 新命令；用旧名会打印一次提示（下个版本从表里删掉即真正移除） */
export const CLI_DEPRECATED: Record<string, string> = {
    // 例：`diy publish` 将来并到 `diy release publish` 时在这里加一行
};
