/**
 * api-domains/agent/impl.ts —— `agent` 域的 handler（38 个）
 *
 * ⚠️ 待展开：带点的平铺键（"local.compact.events"）要先合成嵌套对象。
 */
import type { ServerBinding } from "@diy-agent/rpc";
import type { ToolResultMode } from "@diy-agent/compaction/compaction";
import { agentService } from "./api";
import { localISOString } from "@diy-agent/time";
import { noteRendererTouch } from "../../runtime-context";
import { HUMAN_MEMBER_ID } from "../../../../shared/room";

  // CLI/UI 传来的散字段 → 策略对象（缺省字段由 normalizePolicy 兜底；undefined 覆盖成默认值）
    // 散字段 → **扁平策略对象**（输入面契约；三轴形状由 normalizePolicy 统一生成，见 shared/context/compaction）
function policyOf(i: Record<string, unknown>): unknown {
    return {
      // `budgetBytes` 不再是输入面字段（##432 清理）：历史边界来自 `history.limit.limitTokens`
      // 与已落盘的 turns.jsonl，压缩策略只管工具结果的呈现方式。
      toolResult: (i.toolResult ?? i.toolOutput) as ToolResultMode | undefined,
      headtail: {
        triggerLines: i.triggerLines as number,
        headLines: i.headLines as number,
        tailLines: i.tailLines as number,
        maxLineChars: i.maxLineChars as number,
        maxKeepBytes: i.maxKeepBytes as number,
      },
      summary: i.summary as boolean | undefined,
    };
}

export function bindAgent(server: ServerBinding): void {
    agentService.bind(server, {
        persona: {
            list: async () => {
        const { listPersonas, defaultPersonaId } = await import("../../../core/persona");
        const { diyHome, getTask } = await import("../../../core/state");
        const { listTasks } = await import("../../../core/task");
        const home = diyHome();
        // 引用计数：改人物是**影响所有引用者**的操作，界面必须先看得见影响面
        // （否则「统一修改」退化成盲改）。一次全库扫描，只在打开面板/列表时发生。
        const counts = new Map<string, number>();
        let followCount = 0;
        for (const uri of listTasks()) {
          const id = getTask(uri)?.persona;
          // 没有 persona 键 = **跟随缺省**（不写键就是跟随，见 core/task.ts 与 core/persona.ts）
          if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
          else followCount++;
        }
        return {
          default: defaultPersonaId(home),
          personas: listPersonas(home).map((p) => ({ ...p, taskCount: counts.get(p.id) ?? 0 })),
          // 跟随者不属于任何具体人物，但对"改缺省会影响多少任务"是必须可见的事实
          followCount,
        };
      },
            set: async ({ input }) => {
        const { loadPersonas, savePersonas, assertPersonaDef, personaByIdOrName } = await import("../../../core/persona");
        const { diyHome } = await import("../../../core/state");
        const { reasoningOf } = await import("../../../../shared/models");
        const { nextPersonaId } = await import("../../../../shared/persona");
        const home = diyHome();
        const file = loadPersonas(home);
        // id 优先、名字兜底（CLI 便利）：人记得的是名字，机器需要的是 id
        const target = input.id ? personaByIdOrName(home, input.id) : null;
        if (input.id && !target) throw new Error(`人物 ${input.id} 不存在（可用 diy agent persona list 查看）`);
        const id = target?.id ?? nextPersonaId(Object.keys(file.personas));
        const model = input.model ?? target?.model;
        if (!model) throw new Error(`新建人物必须指定 model（可选模型见 diy agent local models）`);
        const def = {
          name: input.name ?? target?.name ?? `人物${id}`,
          model,
          // 换模型时档位可能不在新模型的支持集内：未显式给档位就取新模型的默认档
          // （沿用旧档会写出一个上游必拒的组合，写入侧直接拦住）
          reasoningEffort:
            input.reasoningEffort ??
            (target && target.model === model ? target.reasoningEffort : reasoningOf(model).default),
          instructions: input.instructions ?? target?.instructions ?? "",
        };
        assertPersonaDef(def);
        savePersonas(home, { ...file, personas: { ...file.personas, [id]: def } });
        return { id, ...def };
      },
            setDefault: async ({ input }) => {
        const { loadPersonas, savePersonas, personaByIdOrName } = await import("../../../core/persona");
        const { diyHome } = await import("../../../core/state");
        const home = diyHome();
        const file = loadPersonas(home);
        const target = personaByIdOrName(home, input.id);
        if (!target) throw new Error(`人物 ${input.id} 不存在（可用 diy agent persona list 查看）`);
        savePersonas(home, { ...file, default: target.id });
        return { default: target.id };
      },
        },
        local: {
            chat: async function* ({ input, signal }) {
        noteRendererTouch("diy.agent.local.chat", input.taskUri);
        const { getLocalAgent } = await import("../../local-agent");
        const agent = getLocalAgent();
        // --mode 给出 = 入队待投递；省略 = 立即开一轮。
        if (input.mode) {
          const items = agent.steerAdd(input.taskUri, input.mode, input.message, input.author);
          // ##436 块 4：留言进信箱。这是**第二个**投递入口（房间投递是另一个，见
          // `room-service.deliverOne`）—— CLI / 别的 agent 代投的留言以前完全不进任何可读的地方，
          // 用户只会被“叫醒”却看不到内容。只记跃迁（来了一条），分级不倒这里管（归 session-alerts）。
          {
            const { messageEntryOf, noteInbox } = await import("../../inbox");
            noteInbox(
              messageEntryOf({
                taskUri: input.taskUri,
                text: input.message,
                ...(input.author ? { author: input.author } : {}),
                // 以本机用户身份从 CLI / UI 发的（`--author human:chen56` 或省略即成缺省本人）⇒ N1，不给自己报信
                selfId: HUMAN_MEMBER_ID,
                ...(items[items.length - 1]?.id ? { steerId: items[items.length - 1]!.id } : {}),
              }),
            );
          }
          // ##303：入队后若**没有活跃轮次**，立刻用它开一轮 —— 留言的语义就是"发一句话"，
          // 空闲时它本就该像普通消息那样马上发出。否则没有任何机制会因它启动轮次，
          // 留言会永远躺在 .diy/drafts.yaml 里（界面只有横条，用户以为已经发出去了）。
          // 判据用 `busy()`（= chat 排队守卫的同一个 turns 注册表）：**判据与动作同源**，
          // 不忙 ⇒ 紧接着的 chatQueued 一定走"真开一轮"，不会被自己的守卫悄悄退回排队。
          if (agent.busy(input.taskUri)) return;
          try {
            for await (const op of agent.chatQueued(input.taskUri, input.model, input.reasoningEffort)) {
              yield JSON.stringify(op);
            }
          } catch (e) {
            // 竞态：判定与开轮之间别人起了轮（chat 的互斥守卫拒发）→ 留言**安好在队列里**，
            // 由那一轮的轮末带走。这里只能吞下错误：不能反手报"入队失败"（它已经入队了）。
            console.warn(`[local-agent] 空闲留言唤醒轮次失败（留言仍在队列，等待投递）${input.taskUri}:`, e);
          }
          return;
        }
        // signal：客户端断开（刷新/切页/杀 CLI）时即时退订 run.subs —— 缺了它，「无 op 产出期间断开」要
        // 等到下一条 op 才释放订阅（return() 排在悬挂的 next() 之后），`subscribers` 会虚高（[5] ##308）。
        for await (const op of agent.chat(
          input.taskUri,
          input.message,
          input.model,
          input.reasoningEffort,
          signal,
          undefined,
          // 第 23 刀：第 7 参从「author 字符串」收成 `TurnOrigin`（再扩不必加第 8 个位次）
          input.author ? { author: input.author } : undefined,
        )) {
          yield JSON.stringify(op);
        }
      },
            cancel: async ({ input }) => {
        noteRendererTouch("diy.agent.local.cancel", input.taskUri);
        const { getLocalAgent } = await import("../../local-agent");
        return { cancelled: getLocalAgent().cancel(input.taskUri) };
      },
            running: async () => {
        const { activeTurnList } = await import("../../runtime-context");
        const { getLocalAgent } = await import("../../local-agent");
        // 订阅者数是**运行时事实**（含 detached 与观测者接入，##305）—— 由 LocalAgentManager 算，
        // runtime-context 只管"哪些任务在跑"（纯内存表，不依赖 agent 层）。
        const agent = getLocalAgent();
        return { active: activeTurnList().map((t) => ({ ...t, subscribers: agent.watchers(t.taskUri) })) };
      },
            turn: async ({ input }) => {
        const { getLocalAgent } = await import("../../local-agent");
        const { sessionRegistry } = await import("../../session-registry");
        const agent = getLocalAgent();
        return {
          taskUri: input.taskUri,
          turnId: input.turnId,
          turn: agent.turnNode(input.taskUri, input.turnId),
          live: sessionRegistry.activeTurnList().some((t) => t.uri === input.taskUri),
          entry: sessionRegistry.entryOf(input.taskUri),
          action: agent.currentAction(input.taskUri),
          now: Date.now(),
        };
      },
            history: async ({ input }) => {
        noteRendererTouch("diy.agent.local.history", input.taskUri);
        const { getLocalAgent } = await import("../../local-agent");
        return getLocalAgent().history(input.taskUri);
      },
            historyWindow: async ({ input }) => {
        noteRendererTouch("diy.agent.local.historyWindow", input.taskUri);
        const { getLocalAgent } = await import("../../local-agent");
        return getLocalAgent().historyWindow(input.taskUri, {
          budgetBytes: input.budgetBytes,
          cursor: input.cursor,
        });
      },
            historyOlder: async ({ input }) => {
        noteRendererTouch("diy.agent.local.historyOlder", input.taskUri);
        const { getLocalAgent } = await import("../../local-agent");
        return getLocalAgent().historyOlder(input.taskUri, {
          cursor: input.cursor,
          budgetBytes: input.budgetBytes,
        });
      },
            historyAt: async ({ input }) => {
        noteRendererTouch("diy.agent.local.historyAt", input.taskUri);
        const { getLocalAgent } = await import("../../local-agent");
        return getLocalAgent().historyAt(input.taskUri, {
          at: input.at,
          budgetBytes: input.budgetBytes,
        });
      },
            find: async ({ input, signal }) => {
        noteRendererTouch("diy.agent.local.find", input.taskUri);
        const { getLocalAgent } = await import("../../local-agent");
        return getLocalAgent().findInSession(input.taskUri, {
          query: input.query,
          scopes: { text: input.text ?? true, tool: input.tool ?? true, think: input.think ?? false },
          maxTurns: input.maxTurns,
          signal,
        });
      },
            opsWatermark: async ({ input }) => {
        const { opsFeed } = await import("../../ops-feed");
        return opsFeed.watermark(input.taskUri);
      },
            opsWatch: async function* ({ input, signal }) {
        const { opsFeed } = await import("../../ops-feed");
        // signal：客户端断开（刷新/切页/杀 CLI）时即时退订。缺了它，无 op 期间断开要等到
        // 下一条 op 才释放订阅（悬挂的 next()），`agent.local.running.subscribers` 会虚高。
        for await (const frame of opsFeed.subscribe(input.taskUri, input.since, input.epoch, signal)) {
          yield frame;
        }
      },
            clear: async ({ input }) => {
        noteRendererTouch("diy.agent.local.clear", input.taskUri);
        const { getLocalAgent } = await import("../../local-agent");
        return { cleared: getLocalAgent().clear(input.taskUri) };
      },
            migrateLayout: async ({ input }) => {
        const { migrateLocalLayout } = await import("../../local-layout-migrate");
        return migrateLocalLayout({ dryRun: input.dryRun !== false, toolout: input.toolout });
      },
            steer: {
                list: async ({ input }) => {
        noteRendererTouch("diy.agent.local.steer.list", input.taskUri);
        const { getLocalAgent } = await import("../../local-agent");
        return getLocalAgent().steerList(input.taskUri);
      },
                cancel: async ({ input }) => {
        noteRendererTouch("diy.agent.local.steer.cancel", input.taskUri);
        const { getLocalAgent } = await import("../../local-agent");
        return getLocalAgent().steerCancel(input.taskUri, input.id);
      },
                toggleMode: async ({ input }) => {
        noteRendererTouch("diy.agent.local.steer.toggleMode", input.taskUri);
        const { getLocalAgent } = await import("../../local-agent");
        return getLocalAgent().steerToggleMode(input.taskUri, input.id);
      },
                reorder: async ({ input }) => {
        noteRendererTouch("diy.agent.local.steer.reorder", input.taskUri);
        const { getLocalAgent } = await import("../../local-agent");
        return getLocalAgent().steerReorder(input.taskUri, input.ids);
      },
                flush: async function* ({ input }) {
        noteRendererTouch("diy.agent.local.steer.flush", input.taskUri);
        const { getLocalAgent } = await import("../../local-agent");
        for await (const op of getLocalAgent().flushSteers(input.taskUri, input.model, input.reasoningEffort)) {
          yield JSON.stringify(op);
        }
      },
            },
            models: async () => {
        const { getLocalAgent } = await import("../../local-agent");
        return getLocalAgent().listModels();
      },
            limits: async () => {
        const { getLocalAgent } = await import("../../local-agent");
        return getLocalAgent().getLimits();
      },
            sessions: async function* ({ input, signal }) {
        const { sessionRegistry } = await import("../../session-registry");
        for await (const frame of sessionRegistry.subscribe({ watch: input.watch ?? false, signal })) {
          yield frame;
        }
      },
            setLimits: async ({ input }) => {
        const { getLocalAgent } = await import("../../local-agent");
        return getLocalAgent().setLimits(input);
      },
            usage: async ({ input }) => {
        noteRendererTouch("diy.agent.local.usage", input.taskUri);
        const { readUsage } = await import("../../usage-report");
        return readUsage(input.taskUri);
      },
            inputGate: async ({ input }) => {
        noteRendererTouch("diy.agent.local.inputGate", input.taskUri);
        const { inputGate } = await import("../../../../shared/context/input-limit");
        const { loadInputLimitChars } = await import("../../../core/input-limit-config");
        const { diyHome } = await import("../../../core/state");
        const { personaForTask } = await import("../../../core/persona");
        const { contextLimitOf, costOf } = await import("../../../../shared/models");
        const { readStepUsages } = await import("../../local-agent");
        const home = diyHome();
        const model = personaForTask(home, input.taskUri).model;
        // 窗口占用 = **最后一步**的总输入 + 总输出（与 turnUsagePatch.windowTotal 同口径）；
        // 没有历史步 → null（不是 0：0 会被算成"窗口空着"，那是个假事实）。
        const last = readStepUsages(input.taskUri).at(-1);
        const windowTokens = last
          ? (last.usage.inputTokens ?? 0) + (last.usage.outputTokens ?? 0)
          : null;
        const contextLimitTokens = last?.contextLimit ?? contextLimitOf(model) ?? null;
        const rates = last?.rates ?? costOf(model, 0);
        return inputGate({
          text: input.text,
          limitChars: loadInputLimitChars(home),
          contextLimitTokens,
          windowTokens,
          inputRatePerM: rates?.input ?? null,
        });
      },
            pasteToFile: async ({ input }) => {
        noteRendererTouch("diy.agent.local.pasteToFile", input.taskUri);
        const { isTaskUri } = await import("../../../../shared/task-uri");
        const { pasteFileMessage } = await import("../../../../shared/context/input-limit");
        const { taskDir } = await import("../../../core/state");
        const { writeFileAtomic } = await import("../../../core/atomic-write");
        const { join } = await import("node:path");
        // 断言函数必须经**显式类型的限定名**调用：TS 的 assertion signature 只认标识符 / 限定名，
        // `(await import(...)).invariant(...)` 与解构出来的裸名都不算（TS2775 / TS2776）。
        const triage: typeof import("../../../../shared/error-triage") = await import("../../../../shared/error-triage");
        triage.invariant(isTaskUri(input.taskUri), "fs/illegal-task-uri", `非法任务 URI：${input.taskUri}`);
        const stamp = localISOString().replace(/[:.]/g, "-");
        const dir = join(taskDir(input.taskUri), "gen", "paste");
        const path = join(dir, `${stamp}.txt`);
        // 原子写（##382 的唯一写原语；父目录由它 mkdir -p）。用户正文只落这一份，
        // 半截文件比没有文件更坏（模型会按残文干活）。
        writeFileAtomic(path, input.text);
        return { path, message: pasteFileMessage({ path, text: input.text }) };
      },
            compact: {
                run: async ({ input }) => {
        noteRendererTouch("diy.agent.local.compact.run", input.taskUri);
        const { getLocalAgent } = await import("../../local-agent");
        const summary =
          input.summaryText !== undefined
            ? { text: input.summaryText, data: (input.summaryData ?? null) as never, cost: input.summaryCost ?? null }
            : undefined;
        // UI / CLI 都是**手动**：无视触发线与内容大小，至少丢一步（##442 用户 2026-10-27）
        return getLocalAgent().compact(input.taskUri, policyOf(input), "cli", summary, "manual", true);
      },
                summarize: async ({ input }) => {
        noteRendererTouch("diy.agent.local.compact.summarize", input.taskUri);
        const { getLocalAgent } = await import("../../local-agent");
        return getLocalAgent().summarize(input.taskUri);
      },
                preview: async ({ input }) => {
        noteRendererTouch("diy.agent.local.compact.preview", input.taskUri);
        const { getLocalAgent } = await import("../../local-agent");
        const txt = (input as { summaryText?: string }).summaryText;
        return await getLocalAgent().compactPreview(input.taskUri, policyOf(input), txt);
      },
                ledger: async ({ input }) => {
        noteRendererTouch("diy.agent.local.compact.ledger", input.taskUri);
        const { keptRoundsView } = await import("../../local-agent");
        return keptRoundsView(input.taskUri);
      },
                setKept: async ({ input }) => {
        noteRendererTouch("diy.agent.local.compact.setKept", input.taskUri);
        const { getLocalAgent, keptRoundsView } = await import("../../local-agent");
        const view = keptRoundsView(input.taskUri);
        const n = Math.max(0, Math.min(view.total, Math.round(input.keepRounds ?? view.total)));
        // 0 轮 = 全清：刻意**不支持**（那等于换一个会话，不是压缩）。界面把它做成禁用位置。
        if (n <= 0) return { budget: 0, applied: null, view };
        // 轮 → token 预算：把要留的那几轮的实测增量加起来（边界落到轮首，与既有判据一致）
        const kept = view.rounds.slice(view.total - n);
        const budget = Math.max(1, kept.reduce((sum, r) => sum + r.tokens, 0));
        const applied = getLocalAgent().compactToRetainTokens(input.taskUri, budget);
        return { budget, applied, view: keptRoundsView(input.taskUri) };
      },
                events: async ({ input }) => {
        noteRendererTouch("diy.agent.local.compact.events", input.taskUri);
        const { getLocalAgent } = await import("../../local-agent");
        return getLocalAgent().compactEvents(input.taskUri);
      },
            },
            autoCompactStatus: async ({ input }) => {
        noteRendererTouch("diy.agent.local.autoCompactStatus", input.taskUri);
        const { getLocalAgent } = await import("../../local-agent");
        return await getLocalAgent().autoCompactStatus(input.taskUri);
      },
            autoCompactSetConfig: async ({ input }) => {
        const { saveAutoCompact, loadAutoCompact } = await import("../../../core/auto-compact-config");
        const { diyHome } = await import("../../../core/state");
        const home = diyHome();
        const cur = loadAutoCompact(home);
        // 部分更新：浅合并（triggers / policy 也是整体替换 —— 调用方给的都是完整子对象，
        // 只给一半反而会让"没提的字段"含义模糊，不如要求完整；缺子对象 = 保留现值）
        const patch = (input.patch ?? {}) as Record<string, unknown>;
        const saved = saveAutoCompact(home, { ...cur, ...patch });
        return saved;
      },
            requestView: async ({ input }) => {
        noteRendererTouch("diy.agent.local.requestView", input.taskUri);
        const { getLocalAgent } = await import("../../local-agent");
        return await getLocalAgent().requestView(input.taskUri);
      },
        },
        usage: async ({ input }) => {
        const { readUsage, renderUsageSteps, renderUsageByAgent } = await import("../../usage-report");
        const steps = readUsage(input.task);
        return input.byAgent
          ? renderUsageByAgent(steps, { last: input.last })
          : renderUsageSteps(steps, { last: input.last, cost: input.cost });
      }
    });
}
