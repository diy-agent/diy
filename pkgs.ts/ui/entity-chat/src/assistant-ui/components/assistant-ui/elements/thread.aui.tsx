import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "../../../components/assistant-ui/elements/attachment.aui";
import { MarkdownText } from "../../../components/assistant-ui/elements/markdown-text";
import { ToolFallback } from "../../../components/assistant-ui/elements/tool-fallback.aui";
import { ToolGroup } from "../../../components/assistant-ui/elements/tool-group.aui";
import { BotAvatar } from "../../../../components/BotAvatar";
import { RunningIndicator } from "../../../../components/RunningIndicator";
import { AskCard } from "../../../../components/AskCard";
import { TooltipIconButton } from "../../../components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  groupPartByType,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  MicIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useState, type FC } from "react";
import type { CustomMeta } from "../../../../projection";
import { completeMention, dismissMention, filterMentionCandidates, mentionQuery, moveActive } from "@diy-agent/chat-core";

import { useMentionBots } from "../../../../mentions";

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

// A switched thread that is still fetching its history: skeleton, not welcome.
const isHistoryLoadingView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading;

const ThreadHistorySkeleton: FC = () => (
  <div
    data-slot="aui_thread-history-skeleton"
    role="status"
    className="animate-in fade-in fill-mode-both flex flex-col [animation-delay:150ms] [animation-duration:200ms]"
  >
    <span className="sr-only">Loading conversation</span>
    <div className="flex animate-pulse flex-col gap-y-6 motion-reduce:animate-none">
      <div className="bg-muted ml-auto h-9 w-2/5 rounded-xl" />
      <div className="flex flex-col gap-y-2">
        <div className="bg-muted h-4 w-11/12 rounded-md" />
        <div className="bg-muted h-4 w-4/5 rounded-md" />
        <div className="bg-muted h-4 w-3/5 rounded-md" />
      </div>
      <div className="bg-muted ml-auto h-9 w-1/3 rounded-xl" />
      <div className="flex flex-col gap-y-2">
        <div className="bg-muted h-4 w-10/12 rounded-md" />
        <div className="bg-muted h-4 w-2/3 rounded-md" />
      </div>
    </div>
  </div>
);

export const Thread: FC = () => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
      style={{
        // 铺满可用宽度（之前 44rem 在宽屏上两侧空太多），靠内边距保持呼吸感
        ["--thread-max-width" as string]: "100%",
        ["--composer-bg" as string]:
          "color-mix(in oklab, var(--color-muted) 30%, transparent)",
        ["--composer-radius" as string]: "1rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        // 模板默认 "top"：新用户消息锚在顶部，助手回复在下方 —— 发完消息后
        // "正在输入" 会落在可视区外。聊天场景用经典 "bottom"（始终贴底）。
        turnAnchor="bottom"
        data-slot="aui_thread-viewport"
        // 无障碍：消息区是 log，流式内容通过 polite 播报（Astryx 的 ChatMessageList 自带同样的语义）
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-6 pt-4",
            isEmpty && "justify-center",
          )}
        >
          <AuiIf condition={isNewChatView}>
            <ThreadWelcome />
          </AuiIf>
          <AuiIf condition={isHistoryLoadingView}>
            <ThreadHistorySkeleton />
          </AuiIf>

          <div
            data-slot="aui_message-group"
            className="mb-14 flex flex-col gap-y-6 empty:hidden"
          >
            <ThreadPrimitive.Messages>
              {() => <ThreadMessage />}
            </ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-background flex flex-col gap-4 overflow-visible pb-4 md:pb-6",
              !isEmpty &&
                "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            <ThreadScrollToBottom />
            <Composer />
            <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);

  if (isEditing) return <EditComposer />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessage />;
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col px-2">
      <p className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-medium tracking-tight duration-200">
        How can I help you today?
      </p>
    </div>
  );
};

const ThreadSuggestions: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-col">
      <ThreadPrimitive.Suggestions>
        {() => <ThreadSuggestionItem />}
      </ThreadPrimitive.Suggestions>
    </div>
  );
};

const ThreadSuggestionItem: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 animate-in fill-mode-both duration-200">
      <SuggestionPrimitive.Trigger send asChild>
        <button
          type="button"
          className="aui-thread-welcome-suggestion group hover:bg-foreground/[0.03] focus-visible:ring-ring/50 flex w-full items-baseline gap-2.5 rounded-md px-2 py-2 text-start text-sm transition-colors outline-none focus-visible:ring-1 motion-reduce:transition-none"
        >
          <span
            aria-hidden
            className="text-muted-foreground/60 group-hover:text-foreground font-mono text-xs transition-colors motion-reduce:transition-none"
          >
            {">"}
          </span>
          <span className="min-w-0 flex-1 truncate">
            <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1 text-foreground" />{" "}
            <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 text-muted-foreground empty:hidden" />
          </span>
        </button>
      </SuggestionPrimitive.Trigger>
    </div>
  );
};

const Composer: FC = () => {
  const bots = useMentionBots();
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  // @ 规则（查询解析/过滤/补全）在 chat-core，与 Astryx 表面共用同一份
  const query = mentionQuery(text);
  const candidates =
    query === null ? [] : filterMentionCandidates(bots, query);

  // 键盘选择：默认选中第一项
  const [active, setActive] = useState(0);
  useEffect(() => {
    setActive(0);
  }, [query]);

  const pick = (name: string) => {
    aui.composer.setText(completeMention(text, name));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (query === null || candidates.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => moveActive(index, 1, candidates.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => moveActive(index, -1, candidates.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = candidates[active];
      if (chosen !== undefined) pick(chosen.name);
    } else if (event.key === "Escape") {
      event.preventDefault();
      aui.composer.setText(dismissMention(text));
    }
  };

  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      {query !== null && candidates.length > 0 && (
        <div className="bg-popover text-popover-foreground absolute bottom-full left-2 z-20 mb-1 w-60 overflow-hidden rounded-xl border p-1 shadow-lg">
          {candidates.map((bot, index) => (
            <button
              key={bot.id}
              type="button"
              data-active={index === active ? "true" : undefined}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(bot.name);
              }}
              className="hover:bg-accent hover:text-accent-foreground data-[active=true]:bg-accent data-[active=true]:text-accent-foreground flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm"
            >
              <span
                className="size-2 rounded-full"
                style={{ background: bot.color }}
              />
              <span>{bot.name}</span>
              {bot.isOwner && (
                <span className="text-muted-foreground ml-auto text-[10px]">
                  owner
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="aui_composer-shell"
          className="border-foreground/10 focus-within:border-foreground/25 data-[dragging=true]:border-ring flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) transition-[border-color] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
        >
          <ComposerAttachments />
          <ComposerPrimitive.Input
            onKeyDown={onKeyDown}
            placeholder="Send a message..."
            className="aui-composer-input placeholder:text-muted-foreground/60 max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 outline-none"
            rows={1}
            autoFocus
            aria-label="Message input"
          />
          <ComposerAction />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC = () => {
  // The stop control only cancels the send while no run it could stop is going.
  const isSending = useAuiState(
    (s) =>
      s.composer.submission !== undefined &&
      !(s.thread.isRunning && s.thread.capabilities.cancel),
  );

  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <ComposerAddAttachment />
      <div className="flex items-center gap-1.5">
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton
                tooltip="Voice input"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-dictate text-muted-foreground hover:text-foreground size-7 rounded-full"
                aria-label="Start voice input"
              >
                <MicIcon className="aui-composer-dictate-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation asChild>
              <TooltipIconButton
                tooltip="Stop dictation"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-stop-dictation text-destructive size-7 rounded-full"
                aria-label="Stop voice input"
              >
                <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
              </TooltipIconButton>
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        <AuiIf
          condition={(s) =>
            !s.composer.canCancel ||
            (s.thread.voice !== undefined &&
              s.composer.submission === undefined)
          }
        >
          <ComposerPrimitive.Send asChild>
            <TooltipIconButton
              tooltip="Send message"
              side="bottom"
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-send size-7 rounded-full"
              aria-label="Send message"
            >
              <ArrowUpIcon className="aui-composer-send-icon size-4" />
            </TooltipIconButton>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf
          condition={(s) =>
            s.composer.canCancel &&
            (s.thread.voice === undefined ||
              s.composer.submission !== undefined)
          }
        >
          <ComposerPrimitive.Cancel asChild>
            <Button
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-cancel size-7 rounded-full"
              aria-label={isSending ? "Cancel sending" : "Stop generating"}
            >
              <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
            </Button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantMessage: FC = () => {
  const ACTION_BAR_PT = "pt-1.5";
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;
  const meta = useAuiState(
    (s) =>
      (s.message.metadata as unknown as { custom?: CustomMeta } | undefined)
        ?.custom,
  );
  const author = meta?.author;

  if (meta?.kind === "typing") {
    // 和正式回复同一套外壳（头像 + 名字），第一段内容到达时原地替换
    return (
      <MessagePrimitive.Root
        data-slot="aui_assistant-message-root"
        data-role="assistant"
        className="fade-in slide-in-from-bottom-1 animate-in relative"
      >
        <div className="text-foreground px-2 leading-relaxed">
          {author !== undefined && (
            <div className="mb-1 flex items-center gap-2 text-xs">
              <BotAvatar author={author} roomId={meta?.roomId} size={18} />
              <span className="font-medium" style={{ color: author.color }}>
                {author.name}
              </span>
              <span className="text-muted-foreground">{author.role}</span>
            </div>
          )}
          <RunningIndicator since={meta.startedAt} />
        </div>
      </MessagePrimitive.Root>
    );
  }

  if (meta?.kind === "error") {
    // 失败是"某个 bot 的回复失败"：和普通助手消息同一条外壳（头像 + 名字），
    // 正文换成错误框。系统提示（notice）才用居中分隔线。
    return (
      <MessagePrimitive.Root
        data-slot="aui_assistant-message-root"
        data-role="assistant"
        className="fade-in slide-in-from-bottom-1 animate-in relative duration-150"
      >
        <div className="px-2">
          {author !== undefined && (
            <div className="mb-1 flex items-center gap-2 text-xs">
              <BotAvatar author={author} roomId={meta?.roomId} size={18} />
              <span className="font-medium" style={{ color: author.color }}>
                {author.name}
              </span>
              <span className="text-muted-foreground">{author.role}</span>
            </div>
          )}
          <MessagePrimitive.Parts
            components={{
              Text: ({ text }: { text: string }) => (
                <div className="border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
                  <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 break-words">{text}</span>
                </div>
              ),
            }}
          />
        </div>
      </MessagePrimitive.Root>
    );
  }

  if (meta?.kind === "notice") {
    return (
      <MessagePrimitive.Root className="my-2">
        <MessagePrimitive.Parts
          components={{
            Text: ({ text }: { text: string }) => (
              <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <span>{text}</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            ),
          }}
        />
      </MessagePrimitive.Root>
    );
  }

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative -mb-7.5 pb-7.5 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div
        data-slot="aui_assistant-message-content"
        className="text-foreground px-2 leading-relaxed wrap-break-word"
      >
        {author !== undefined && (
          <div className="mb-1 flex items-center gap-2 text-xs">
            <BotAvatar author={author} roomId={meta?.roomId} size={18} />
            <span className="font-medium" style={{ color: author.color }}>
              {author.name}
            </span>
            <span className="text-muted-foreground">{author.role}</span>
          </div>
        )}
        {/* 相邻的工具调用折叠成一组（与 Astryx 的 ChatToolCalls 一个约定） */}
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({ "tool-call": ["group-tool"] })}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-tool":
                return part.indices.length <= 1 ? (
                  <>{children}</>
                ) : (
                  <ToolGroup count={part.indices.length}>{children}</ToolGroup>
                );
              case "text":
                return <MarkdownText />;
              case "tool-call":
                return part.toolUI ?? <ToolFallback {...part} />;
              case "data": {
                // 投影层用 `data-ask` 传入，运行时规范成 { type: "data", name: "ask" }
                if (part.name !== "ask") return null;
                const request = (part.data as { request?: import("@diy-agent/chat-core").AskRequest }).request;
                return request === undefined ? null : (
                  <AskCard roomId={meta?.roomId ?? ""} request={request} />
                );
              }
              case "indicator":
                return (
                  <span
                    data-slot="aui_assistant-message-indicator"
                    className="animate-pulse font-sans"
                    aria-label="Assistant is working"
                  >
                    {"●"}
                  </span>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        {/* 还在跑但没有流式内容（工具刚结束 / 等下一段）：挂在本条消息末尾 */}
        {meta?.waiting === true && (
          <div className="mt-1.5">
            <RunningIndicator since={meta.startedAt} />
          </div>
        )}
        <AuiIf
          condition={(s) =>
            s.message.status?.type === "running" && s.message.parts.length === 0
          }
        >
          <span
            data-slot="aui_assistant-message-indicator"
            className="animate-pulse font-sans"
            aria-label="Assistant is working"
          >
            {"●"}
          </span>
        </AuiIf>
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        <BranchPicker />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="Refresh">
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip="More"
            className="data-[state=open]:bg-accent"
          >
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover/95 text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5 shadow-lg backdrop-blur-sm"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              Export as Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const deliveryLabel = (state: string): string => {
  if (state === "queued") return "排队";
  if (state === "delivering") return "发送中";
  if (state === "delivered") return "已收到";
  if (state === "failed") return "失败";
  return "跳过";
};

const UserMessage: FC = () => {
  const meta = useAuiState(
    (s) =>
      (s.message.metadata as unknown as { custom?: CustomMeta } | undefined)
        ?.custom,
  );
  const deliveries = meta?.deliveries ?? [];

  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer bg-muted text-foreground rounded-(--composer-radius) px-4 py-2 wrap-break-word empty:hidden">
          <MessagePrimitive.Parts />
        </div>
        <div className="aui-user-action-bar-wrapper absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
          <UserActionBar />
        </div>
      </div>

      <BranchPicker
        data-slot="aui_user-branch-picker"
        className="col-span-full col-start-1 -me-1 justify-end"
      />
      {deliveries.length > 0 && (
        <div className="col-start-2 flex flex-wrap justify-end gap-1.5 pt-0.5">
          {deliveries.map((delivery) => (
            <span
              key={delivery.botId}
              className="flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              <BotAvatar
                author={{ id: delivery.botId, name: delivery.name, color: delivery.color, role: 'bot' }}
                roomId={meta?.roomId}
                size={13}
              />
              {delivery.name}
              <span>{deliveryLabel(delivery.state)}</span>
            </span>
          ))}
        </div>
      )}
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="Edit" className="aui-user-action-edit">
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root border-foreground/10 focus-within:border-foreground/25 ms-auto flex w-full max-w-[85%] cursor-text flex-col rounded-(--composer-radius) border bg-(--composer-bg) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color] dark:shadow-none">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-8 px-3">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-8 px-3">
              Update
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="Previous">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
