/**
 * api-domains/instances/impl.ts —— `instances` 域的 handler（从 api-impl.ts 拆出）。
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { instancesService } from "./api";
import { currentGitBranch, repoDisplayOf } from "../../../core/instance-identity";
import { revealSelf, windowState } from "../../window-ops";
import { renderInstanceList, collectInstances, selfReport, focusInstance } from "../../instances";

export function bindInstances(server: ServerBinding): void {
    instancesService.bind(server, {
      ls: async () => renderInstanceList(),
      list: async () => ({ rows: await collectInstances() }),
      self: async () =>
        selfReport({ window: windowState(), branch: currentGitBranch() ?? "", repoDisplay: repoDisplayOf() }),
      reveal: async () => revealSelf(),
      focus: async ({ input }) => {
        if (input.pid === undefined && input.port === undefined) {
          throw new Error("必须给 --pid 或 --port（目标实例；先跑 diy instances ls 看当前有哪些）");
        }
        const r = await focusInstance({ pid: input.pid, port: input.port });
        return { pid: r.pid, port: r.port, via: r.via, reason: r.reason };
      },
    });
}
