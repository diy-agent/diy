// src/main/core/cwd.ts
// 🎯 工具工作目录（cwd）解析的**唯一实现**。
//
// 为什么单独抽：prompt-registry（装配系统提示词里的「工作目录」）与 local-agent（bash/read 的真实 cwd）
// 曾各自维护一份镜像逻辑（注释自述「TODO: 合并为一处实现」）。两份实现已经开始漂移
// （`~` 展开、无效路径留痕、note 文案各写一份），而漂移的后果是模型读到的工作目录
// 与工具实际执行的目录不一致 —— 它按提示词里的相对路径去操作，就会操作错地方。
//
// 三级兜底（逐级存在性校验）：项目目录（state.yaml 登记 path）→ 任务目录 → 进程 cwd。
// 返回值带 note：与项目目录不一致时给出提示，供提示词模版 `{{cwd_note}}` 渲染。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getProjectPath } from "./project";
import { projectFromUri } from "../../shared/task-uri";

export interface ResolvedCwd {
  /** 工具实际执行目录（bash/read 的基准） */
  cwd: string;
  /** 与项目目录不一致时的中文提示（一致时为空串）；进 `{{cwd_note}}` */
  note: string;
}

/** `~` 展开（只用 $HOME，不猜别的家目录来源） */
function expand(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/**
 * 解析工具工作目录。
 * @param home DIY_HOME（任务目录 = home + taskUri；显式传入以保证测试隔离生效）
 * @param taskUri 任务 URI（projects/<pid>/tasks/<tid>）
 */
export function resolveCwd(home: string, taskUri: string): ResolvedCwd {
  const declared = getProjectPath(projectFromUri(taskUri));
  if (declared) {
    const abs = expand(declared);
    try {
      if (existsSync(abs)) return { cwd: abs, note: "" };
    } catch (e) {
      // 无效路径回退可接受，但要留痕（如权限/非法字符导致 stat 抛错）
      console.warn(`[cwd] 项目目录探测失败 ${abs}:`, e);
    }
  }
  const td = taskUri ? join(home, taskUri) : "";
  if (td) {
    try {
      if (existsSync(td)) {
        return { cwd: td, note: "\n注意：项目目录不存在，工具实际在任务目录下执行" };
      }
    } catch (e) {
      console.warn(`[cwd] 任务目录探测失败 ${td}:`, e);
    }
  }
  return { cwd: process.cwd(), note: "\n注意：项目目录与任务目录都不存在，工具实际在应用目录下执行" };
}
