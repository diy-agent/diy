/**
 * services/env-list.ts —— `diy env ls` 的人读表格
 *
 * 2026-11-06 从 `api-impl.ts` 提出来：`env` 域拆到 `api-domains/env/impl.ts` 后两边都要用。
 */
import { fmtDiskBytes, type EnvNotice } from "../../shared/env-watch";

/**
 * `diy env ls` 的人读表格（对齐 instances.ls 的口径：给人看，不是给程序解析）。
 *
 * 数字**一律给**（`rule`：更明确的识别 = 给数字，不是给形容词）：只写"磁盘可能满了"
 * 对排查没有价值。
 */
export function renderEnvList(rows: EnvNotice[]): string {
  if (rows.length === 0) return "环境正常：磁盘水位充足、网络无连续失败。";
  const lines = rows.map((n) => {
    switch (n.type) {
      case "disk-full":
      case "disk-low": {
        const d = n.data;
        const size =
          d.availBytes < 0 || d.totalBytes < 0
            ? "可用空间读不到"
            : `可用 ${fmtDiskBytes(d.availBytes)} / 共 ${fmtDiskBytes(d.totalBytes)}`;
        const from = d.source === "write-error" ? "（写失败被动升级）" : "（轮询）";
        return `[${n.level}] ${n.type}  ${d.mount || "?"}  ${size}${from}  ${d.reason}  (id=${n.id})`;
      }
      case "network-down": {
        const d = n.data;
        return `[${n.level}] ${n.type}  连续 ${d.streak} 次${d.code ? ` ${d.code}` : ""}  ${d.message}  ${d.reason}  (id=${n.id})`;
      }
    }
  });
  return lines.join("\n");
}
