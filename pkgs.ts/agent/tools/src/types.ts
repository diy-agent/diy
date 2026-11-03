// pkgs.ts/agent/tools/src/types.ts — 工具层的**宿主无关**契约
//
// 边界（##514）：
//   属于本包：read / write / edit 的定义与它们的纯内核（文件窗口、原子写、diff、局部替换）
//   不属于本包：任务系统（taskUri / 审计落盘位置 / 会话目录）、进程与后台作业（bash / job）、
//               OS 策略选型（shell 探测在宿主，见 apps/diy-app/src/main/os/）
// 判据：本包 import 清单里不许出现 electron / 应用数据根 / 任务标识（同 @diy-agent/session 的硬口径）。

/** 工具执行审计事件（**宿主决定写去哪**：diy-app 落 agent-bash.jsonl，bot 可不传） */
export interface ToolAuditEvent {
    /** 阶段（与宿主审计词表对齐：file-write / file-edit-start / file-edit-end） */
    readonly phase: "file-write" | "file-edit-start" | "file-edit-end";
    /** 执行时的项目目录 */
    readonly cwd: string;
    /** 目标文件（相对 cwd） */
    readonly command?: string;
    /** 目标文件（相对 cwd，edit 用） */
    readonly path?: string;
    /** 结果摘要（已截断） */
    readonly result?: string;
    /** 耗时 ms（*_end 用） */
    readonly ms?: number;
}

/** 工具层的预算（只收工具自己用得到的；宿主的大配置结构不进来） */
export interface ToolLimits {
    /** read 工具单次返回的字节上限（缺省 `READ_MAX_BYTES`） */
    readonly readMaxBytes?: number;
}
