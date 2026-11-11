/**
 * api-domains/context/impl.ts —— `context` 域的 handler
 *
 * 从 api-impl.ts 拆出。**按行号切**（`binding.on(app.context.x, ` 到下一个 `  });`），
 * 不依赖注释分组、也不算字符偏移 —— 那两种都踩过坑。
 */
import type { ServerBinding } from "@diy-agent/rpc";
import type { HistoryEntryView } from "../../../../shared/context/schema";
import { contextApi } from "./api";

export function bindContext(server: ServerBinding): void {
    server.use({
        prefix: "diy",
        api: contextApi,
        // 模块层由模块自己声明（context）：与 defineService(name: "diy.context") 等价
        handlers: {
            context: {
            candidates: async () => {
            const { PLACE_CANDIDATES } = await import("../../../../shared/context/preview");
            return { candidates: PLACE_CANDIDATES };
            },
            lab: async ({ input }) => {
            const { assembleGlobals } = await import("../../prompt-registry");
            const { diyHome, projectFromUri } = await import("../../../core/state");
            const { buildLab } = await import("../../../../shared/context/preview");
            const taskUri = input.taskUri ?? "";
            const project = projectFromUri(taskUri) || input.project;
            // 真实数据：与真发同一条组装链（同样的 AGENTS.md 链、同样的 cwd 推导）
            const globals = assembleGlobals(diyHome(), project, { taskUri }) as unknown as Record<string, unknown>;
            // 先用纯函数算出信封，再用**真发的构造链**把请求体拼出来
            const lab = buildLab(globals, taskUri);
            let request: { body: Record<string, unknown> | null; note: string; model: string } = {
              body: null,
              note: "无任务场景：仅组装上下文，未构造请求体",
              model: "",
            };
            if (taskUri) {
              const { previewSimulatedRequest } = await import("../../local-agent");
              const { getModelCatalog } = await import("../../../../shared/models");
              // 无缺省模型：预演不指定就用目录首项（目录空 = 无 provider，model 为空 → 预演只组装不发）
              const model = input.model || getModelCatalog()[0]?.ref || "";
              const sim = await previewSimulatedRequest({
                taskUri,
                // system 里已含 help / vars 两份全量（##520：只有一份变量树）
                system: lab.text.text,
                model,
              });
              request = { body: sim.body, note: sim.note, model };
            }
            return { ...lab, request };
            },
            steps: async ({ input }) => {
            const { readDeliverySteps } = await import("../../local-agent");
            const { summarizeSteps } = await import("../../../../shared/context/steps");
            const records = readDeliverySteps(input.taskUri);
            return {
              total: records.length,
              steps: summarizeSteps(records, { limit: input.limit, withDiff: input.diff === true }),
            };
            },
            stats: async ({ input }) => {
            const { readContextStats } = await import("../../../core/context-stats");
            const { summarizeStats, dropBaselineChanges } = await import("../../../../shared/context/stats");
            const { projectDir, projectFromUri } = await import("../../../core/state");
            // project 以 taskUri 为准（与 lab/diff 同一口径：两者不一致时只有 CLI 能造成）
            const project = input.taskUri ? projectFromUri(input.taskUri) || input.project : input.project;
            // 首轮基线不算变化：老文件（写入器修前）每任务首轮把全部 path 记成变化 → 在这里抹平。
            // 必须在 filter/slice **之前**（切完片最早那条已不是首轮，无从分辨）—— review RV-15。
            let records = dropBaselineChanges(readContextStats(projectDir(project)));
            if (input.taskUri) records = records.filter((r) => r.taskUri === input.taskUri);
            const total = records.length;
            if (input.limit && input.limit > 0) records = records.slice(-input.limit);
            return { ...summarizeStats(records), records: total };
            },
            changelog: async ({ input }) => {
            const { readCtxLog } = await import("../../../core/context-changelog");
            const { isV2Entry, entryToRows, foldCtxLog, opsFromHashes } = await import("../../../../shared/context/changelog");
            const { readDeliverySteps, readStepUsages } = await import("../../local-agent");
            const { groupByTurn } = await import("../../../../shared/usage");
            const steps = readDeliverySteps(input.taskUri);
            // 每条 ref 的徽章：投递快照（划分 + 两份容器是否变）与用量账本（缓存率 + 金额）都按 turnId join。
            // 都**可能不可得**（快照被清、老账本没字段）→ 给 null，UI 不画徽章，不谎报"没变"。
            const stepIdx = new Map(steps.map((s, i) => [s.turnId, i]));
            const usage = new Map(groupByTurn(readStepUsages(input.taskUri)).map((g) => [g.turnId, g]));
            const badges = (turnId: string) => {
              const i = stepIdx.get(turnId);
              const cur = i === undefined ? undefined : steps[i];
              const prev = i !== undefined && i > 0 ? steps[i - 1] : undefined;
              const buckets = usage.get(turnId)?.buckets;
              return {
                turnIndex: i === undefined ? null : i + 1,
                systemDiffers: cur && prev ? cur.systemText !== prev.systemText : null,
                // 注记段缺字段（老快照）= 不知道 ⇒ null（UI 不画徽章），别拿 undefined 跟字符串比得「变了」
                historyDiffers: cur?.historyText === undefined || prev?.historyText === undefined ? null : cur.historyText !== prev.historyText,
                incomparable: cur && prev ? cur.wireVersion !== prev.wireVersion : null,
                cacheHitRate: buckets && buckets.inputTotal > 0 ? buckets.cacheRead / buckets.inputTotal : null,
                cost: usage.get(turnId)?.cost ? usage.get(turnId)!.cost!.total : null,
              };
            };
    
            const raw = readCtxLog(input.taskUri);
            const v2 = raw.filter(isV2Entry);
            const entries: HistoryEntryView[] = [];
            let source: "log" | "derived" = "log";
            if (v2.length > 0) {
              // 二版：before/after 自带 → 直接可渲染（不再回放）
              for (const e of v2) {
                entries.push({
                  seq: e.seq,
                  type: e.type,
                  ts: e.ts,
                  model: e.model,
                  wireVersion: e.wireVersion,
                  ref: e.ref,
                  changes: entryToRows(e),
                  ...badges(e.ref.turnId),
                });
              }
            } else {
              // 降级：老格式日志（一版回放）或纯折算（从投递快照的值 hash 差还原；无值预览）
              const legacy = raw.filter((r) => !isV2Entry(r));
              source = legacy.length > 0 ? "log" : "derived";
              const records =
                legacy.length > 0
                  ? (legacy as unknown as Parameters<typeof foldCtxLog>[0])
                  : steps.map((s, i) => ({
                      ts: s.ts,
                      turnId: s.turnId,
                      model: s.model,
                      wireVersion: s.wireVersion,
                      ops: opsFromHashes(i === 0 ? null : steps[i - 1]!.valueHashes, s.valueHashes),
                    }));
              for (const t of foldCtxLog(records)) {
                entries.push({
                  seq: t.index - 1,
                  type: t.baseline ? "baseline" : "changed",
                  ts: t.ts,
                  model: t.model,
                  wireVersion: t.wireVersion,
                  ref: { turnId: t.turnId, stepId: t.turnId, step: t.index },
                  changes: t.changes,
                  ...badges(t.turnId),
                });
              }
            }
            // **只要变化**：降级路径（老格式日志回放 / 从投递快照折算）会**每步**给一条 —— 没变的那步
            // 落在时间线上就是一个空行，实测老任务里能占掉一多半（用户 2026-10-22：「变化步骤很多是空
            // 步骤，只需要变化的步骤才记录和显示」）。v2 记录本身"有变才写"，这里的过滤对它无副作用，
            // 对降级路径是**显示侧的兜底**（记录侧无从修：那些步的日志已经写死了）。
            // baseline 不在过滤之列 —— 它是时间线的起点，不是"某一步的变化"。
            const kept = entries.filter((e) => e.type === 'baseline' || e.changes.length > 0);
            const total = kept.length;
            return {
              total,
              source,
              entries: input.limit && input.limit > 0 ? kept.slice(-input.limit) : kept,
            };
            },
            rebaseline: async ({ input }) => {
            const { getLocalAgent } = await import("../../local-agent");
            getLocalAgent().markRebaseline(input.taskUri);
            return {
              ok: true,
              message:
                "已置位：该任务下一次真发时落一条新 baseline（起点）。" +
                "（轮次中途置位则下一轮生效 —— 起点只能在轮首写）",
            };
            },
            diff: async ({ input }) => {
            const { readDeliverySteps } = await import("../../local-agent");
            const { diffSteps } = await import("../../../../shared/context/steps");
            const records = readDeliverySteps(input.taskUri);
            if (records.length === 0) return null;
            // 选中第 N 步：与第 N-1 步比（两侧都在文件里）
            if (input.step !== undefined) {
              const idx = Math.trunc(input.step);
              const cur = records[idx - 1];
              const prev = idx - 1 >= 1 ? records[idx - 2] : null;
              if (!cur) return null;
              const d = prev ? diffSteps(prev, cur) : null;
              return {
                mode: "step" as const,
                base: prev ? { index: idx - 1, ts: prev.ts, turnId: prev.turnId } : null,
                target: { index: idx, ts: cur.ts, turnId: cur.turnId, model: cur.model },
                incomparable: d?.incomparable ?? false,
                changed: d?.changed ?? Object.keys(cur.valueHashes).sort(),
                systemDiffers: d?.systemDiffers ?? true,
                historyDiffers: d?.historyDiffers ?? false,
                systemDiff: d?.systemDiff ?? [],
                historyDiff: d?.historyDiff ?? [],
                systemText: cur.systemText,
                historyText: cur.historyText ?? "",
                baseSystemText: prev?.systemText ?? null,
                baseHistoryText: prev?.historyText ?? null,
              };
            }
            // 未选中：**当前变量树** vs 最后一步（"我现在改的东西会带来什么变化"）
            const { assembleGlobals } = await import("../../prompt-registry");
            const { diyHome, projectFromUri } = await import("../../../core/state");
            const { buildDelivery } = await import("@diy-agent/context/delivery");
            const project = projectFromUri(input.taskUri) || input.project;
            // 房间上下文（##377 第 26 刀）：预览与真发同一份装配（取**本任务自己的房间**）
            const { roomRuntimeFact } = await import("../../room-context");
            const roomCtx = (await roomRuntimeFact({ roomId: input.taskUri, taskUri: input.taskUri }))?.value ?? null;
            const globals = assembleGlobals(diyHome(), project, {
              taskUri: input.taskUri,
              room: roomCtx,
            }) as unknown as Record<string, unknown>;
            const now = buildDelivery(globals);
            const last = records[records.length - 1]!;
            const d = diffSteps(last, {
              ...last,
              wireVersion: now.wireVersion,
              valueHashes: now.valueHashes,
              systemText: now.text.text,
            });
            return {
              mode: "live" as const,
              base: { index: records.length, ts: last.ts, turnId: last.turnId },
              target: null,
              incomparable: d.incomparable,
              changed: d.changed,
              systemDiffers: d.systemDiffers,
              // live 模式比的是「当前变量树 vs 最后一步」：注记段**不属于变量树**（它由压缩选择算），
              // 当前没有"待发的注记"⇒ 不存在可比对象，恒 false；历史行对照仍给 baseHistoryText。
              historyDiffers: false,
              systemDiff: d.systemDiff,
              historyDiff: d.historyDiff,
              systemText: now.text.text,
              historyText: "",
              baseSystemText: last.systemText,
              baseHistoryText: last.historyText ?? null,
            };
            },
        } },
    });
}
