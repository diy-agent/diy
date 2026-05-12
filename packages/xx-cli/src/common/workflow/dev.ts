import { UserError } from "./errors.js";
import { ghIssueView, ghPrList, ghPrCreate, ghPrMerge, ghRepoMergeMethod } from "./github.js";
import {
  gitWorktreeList, gitWorktreeRemove, gitBranchDeleteForce, gitCheckout, gitPull, gitPush,
} from "./git.js";
import { parseIssueNumber, getCurrentBranch, getMainBranch, getMergeBase, run } from "./helpers.js";
import type { WorktreeRow, PRInfo, IssueInfo } from "./types.js";
import { logger } from "../logger.js";
import {
  Markdown, type MarkdownTheme,
  ProcessTerminal, TUI, Container, SelectList, Text,
  type SelectItem, type SelectListTheme,
} from "@mariozechner/pi-tui";

/** CLI 场景用纯文本主题，不依赖 initTheme() */
const plainTheme: MarkdownTheme = {
  heading:         (s) => s,
  link:            (s) => s,
  linkUrl:         (s) => s,
  code:            (s) => s,
  codeBlock:       (s) => s,
  codeBlockBorder: (s) => s,
  quote:           (s) => s,
  quoteBorder:     (s) => s,
  hr:              (s) => s,
  listBullet:      (s) => s,
  bold:            (s) => s,
  italic:          (s) => s,
  strikethrough:   (s) => s,
  underline:       (s) => s,
};

const log = logger.withTag("dev");

export class DevWorkflow {
  constructor(private repo: string) {}

  /** 列出所有 worktree 及其关联 issue / PR */
  async list(): Promise<WorktreeRow[]> {
    const worktrees = gitWorktreeList();

    // 批量获取 PR 信息
    const prMap: Map<string, PRInfo> = new Map();
    try {
      const prs = ghPrList(this.repo);
      for (const pr of prs) {
        prMap.set(pr.headRefName, {
          number: pr.number,
          title: pr.title,
          state: pr.state,
          url: pr.url,
          mergeable: pr.mergeable ?? "UNKNOWN",
          headRefName: pr.headRefName,
        });
      }
    } catch { /* PR 列表获取失败，继续 */ }

    // 为每个 worktree 构建行数据
    const rows: WorktreeRow[] = [];
    for (const wt of worktrees) {
      const issueNum = parseIssueNumber(wt.branch);
      let issue: IssueInfo | undefined;
      if (issueNum) {
        try {
          const data = ghIssueView(issueNum, this.repo, "number,title,state,url,createdAt,author");
          issue = {
            number: data.number,
            title: data.title,
            state: data.state,
            url: data.url,
            createdAt: data.createdAt,
            author: (data.author as any)?.login ?? "-",
          };
        } catch { /* issue 获取失败 */ }
      }

      rows.push({
        worktree: wt,
        issue,
        pr: prMap.get(wt.branch),
      });
    }

    // Markdown 表格输出
    if (rows.length === 0) {
      log.info("没有 worktree");
      return rows;
    }

    const termWidth = process.stdout.columns ?? 120;
    const md = new Markdown(this.buildTableMarkdown(rows), 0, 0, plainTheme);
    for (const line of md.render(termWidth)) {
      console.log(line);
    }

    return rows;
  }

  /** 构建 Markdown 表格字符串 */
  private buildTableMarkdown(rows: WorktreeRow[]): string {
    const header = ["Path", "Branch", "Ahead", "PR", "PR State", "Mergeable", "Issue State", "Title"];
    const sep    = header.map(() => "---");
    const body = rows.map((row) => {
      const wt = row.worktree;
      return [
        wt.isPrunable ? `\`${wt.shortPath}\` *prunable*` : wt.shortPath,
        wt.branchDisplay,
        String(wt.ahead),
        row.pr ? `#${row.pr.number}` : "-",
        row.pr?.state ?? "-",
        row.pr?.mergeable ?? "-",
        row.issue?.state ?? "-",
        (row.issue?.title ?? "-").replace(/\|/g, "\\|"),
      ];
    });

    const toRow = (cells: string[]) => `| ${cells.join(" | ")} |`;
    return [toRow(header), toRow(sep), ...body.map(toRow)].join("\n");
  }

  /** 当前分支详情（Git + Issue + PR） */
  async status(): Promise<void> {
    const branch = getCurrentBranch();
    const mainBranch = getMainBranch();

    console.log("=== Git 信息 ===");
    console.log(`  分支:             ${branch}`);
    console.log(`  基准分支:         ${mainBranch}`);
    console.log(`  仓库:             ${this.repo}`);

    // 未提交变更
    const statusOut = run("git status --porcelain");
    if (statusOut.trim()) {
      const count = statusOut.split("\n").filter((l) => l.trim()).length;
      console.log(`  变更:             ${count} 个文件未提交`);
    } else {
      console.log("  变更:             干净");
    }

    // ahead/behind
    if (branch !== mainBranch) {
      try {
        const ahead = Number(run(`git rev-list --count "${mainBranch}..${branch}"`).trim());
        const behind = Number(run(`git rev-list --count "${branch}..${mainBranch}"`).trim());
        if (ahead > 0 || behind > 0) {
          console.log(`  追踪:             ↑${ahead} ahead, ↓${behind} behind ${mainBranch}`);
        }
      } catch { /* ignore */ }
    }

    // Issue 信息
    const issueNum = parseIssueNumber(branch);
    if (!issueNum) {
      console.log(`\n⚠ 分支 "${branch}" 无法解析 issue 编号`);
      return;
    }

    console.log("\n=== Issue 信息 ===");
    try {
      const data = ghIssueView(issueNum, this.repo, "number,title,state,url,createdAt,author");
      console.log(`  #${data.number}  ${data.title}`);
      console.log(`  状态:           ${data.state}`);
      console.log(`  作者:           ${(data.author as any)?.login ?? "-"}`);
      console.log(`  创建:           ${data.createdAt}`);
      console.log(`  URL:            ${data.url}`);
    } catch {
      log.warn(`无法获取 issue #${issueNum}`);
    }

    // PR 信息
    console.log("\n=== PR 信息 ===");
    try {
      const prs = ghPrList(this.repo, branch);
      if (prs.length > 0) {
        const pr = prs[0];
        console.log(`  #${pr.number}  ${pr.title}`);
        console.log(`  状态:           ${pr.state}`);
        console.log(`  可合并:         ${pr.mergeable ?? "UNKNOWN"}`);
        console.log(`  URL:            ${pr.url}`);
      } else {
        console.log("  未找到关联 PR");
      }
    } catch {
      console.log("  无法获取 PR 信息");
    }

    // 分支示意图
    console.log("\n=== 分支示意图 ===");
    const diagram = buildBranchDiagram(branch, mainBranch);
    const termWidth = process.stdout.columns ?? 120;
    const md = new Markdown(diagram, 0, 0, plainTheme);
    for (const line of md.render(termWidth)) {
      console.log(line);
    }
    console.log();
  }

  /** 创建 PR */
  async pr(): Promise<void> {
    const branch = getCurrentBranch();
    const mainBranch = getMainBranch();

    if (branch === mainBranch) {
      throw new UserError("不能在主分支创建 PR");
    }

    // 检查未提交变更
    const statusOut = run("git status --porcelain");
    if (statusOut.trim()) {
      throw new UserError("有未提交的变更，请先提交再创建 PR");
    }

    const issueNum = parseIssueNumber(branch);
    if (!issueNum) {
      throw new UserError(`无法从分支 "${branch}" 解析 issue 编号`);
    }

    // 获取 issue 标题作为 PR 标题
    const issue = ghIssueView(issueNum, this.repo, "title");
    if (!issue?.title) {
      throw new UserError(`找不到 issue #${issueNum}`);
    }

    // 检查是否已有 open PR
    const existing = ghPrList(this.repo, branch, "open");
    if (existing.length > 0) {
      // 推送新的 commit 到已有 PR
      gitPush();
      log.warn(`分支 "${branch}" 已存在 open PR #${existing[0].number}，新 commit 已推送`);
      log.info(`合并方式: workflow dev merge-pr 或到 ${existing[0].url} 页面手动合并`);
      return;
    }

    // 推送
    gitPush();

    // 创建 PR
    const prNum = ghPrCreate(this.repo, mainBranch, branch, issue.title, `Complete #${issueNum}`);
    log.success(`成功: 创建 PR #${prNum}`);
  }

  /** 合并 PR */
  async mergePr(method?: string): Promise<void> {
    const branch = getCurrentBranch();
    const mainBranch = getMainBranch();

    if (branch === mainBranch) {
      throw new UserError("请在 worktree 分支执行，不能在主分支");
    }

    const prs = ghPrList(this.repo, branch, "open");
    if (prs.length === 0) {
      throw new UserError(`分支 "${branch}" 没有 open PR`);
    }

    const prNum = prs[0].number;

    // 预检 mergeable 状态（在 TUI 之前，避免用户白选）
    if (prs[0].mergeable === "CONFLICTING") {
      const prUrl = prs[0].url;
      throw new UserError(
        `PR #${prNum} 与 ${mainBranch} 有冲突，请先解决冲突\n` +
        `\n` +
        `  页面操作: ${prUrl}\n` +
        `\n` +
        `  手工命令:\n` +
        `    git fetch origin\n` +
        `    git rebase origin/${mainBranch}\n` +
        `    # 解决冲突后:\n` +
        `    git add .\n` +
        `    git rebase --continue\n` +
        `    git push --force-with-lease\n` +
        `\n` +
        `  解决后重新执行: workflow dev merge-pr`
      );
    }

    // 交互模式：如果没指定 method，显示选择器 TUI
    if (!method) {
      const availableMethods = ghRepoMergeMethod(this.repo);
      const methods = availableMethods.split(",");
      if (methods.length === 1) {
        method = methods[0];
      } else {
        const selected = await selectMethod(methods);
        if (!selected) {
          log.info("已取消合并");
          return;
        }
        method = selected;
      }
    }

    ghPrMerge(prNum, this.repo, method);
    log.success(`成功: PR #${prNum} 已合并 (${method})`);
  }

  /** 删除 worktree 和分支 */
  async remove(): Promise<void> {
    const branch = getCurrentBranch();
    const mainBranch = getMainBranch();

    if (branch === mainBranch) {
      throw new UserError("请在 worktree 分支执行，不能在主分支");
    }

    // 预检
    console.log("=== 删除预检 ===");

    // 检查是否有未推送 commit
    try {
      const upstream = run("git rev-parse --abbrev-ref '@{upstream}'");
      const ahead = Number(run(`git rev-list --count "${upstream}..${branch}"`).trim());
      if (ahead > 0) {
        throw new UserError(`有 ${ahead} 个未推送的 commit，请先推送`);
      }
    } catch (err: any) {
      if (err.message?.includes("未推送")) throw err;
      // 没有 upstream，检查是否推送过
      try {
        run("git ls-remote --heads origin " + branch);
      } catch {
        log.warn("远程分支不存在，可能有未推送的 commit");
      }
    }

    // 检查是否有 open PR
    const prs = ghPrList(this.repo, branch, "open");
    if (prs.length > 0) {
      throw new UserError(`存在 open PR #${prs[0].number}，请先合并或关闭`);
    }

    console.log("预检通过，开始删除...");

    const worktreePath = `.worktree/${branch}`;

    // 切回主分支
    gitCheckout(mainBranch);
    gitPull();

    // 删除 worktree
    gitWorktreeRemove(worktreePath);

    // 删除本地分支（-D 强删，因为 PR 已合并但本地可能未 pull）
    gitBranchDeleteForce(branch);

    log.success(`成功: 已删除 worktree 和分支 "${branch}"`);
  }
}

/** 合并策略的中文描述 */
const MERGE_METHOD_DESC: Record<string, string> = {
  merge:  "创建合并提交 (merge commit)",
  squash: "将所有提交压缩为一条 (squash)",
  rebase: "变基合并 (rebase)",
};

/** 合并策略的 ASCII 示意图（Markdown 格式） */
const MERGE_METHOD_DIAGRAM: Record<string, string> = {
  merge: [
    "### Merge（合并提交）",
    "",
    "```",
    "PR 合并前:",
    "  main:  A---B---C",
    "           \\",
    "  分支:     D---E---F",
    "",
    "PR 合并后:",
    "  main:  A---B---C-------M",
    "           \\             /",
    "  分支:     D---E---F---",
    "```",
    "",
    "> 保留完整分支历史，M 是新的 merge commit",
    "",
    "**原始命令:** `git checkout main && git merge 分支`",
  ].join("\n"),
  squash: [
    "### Squash（压缩合并）",
    "",
    "```",
    "PR 合并前:",
    "  main:  A---B---C",
    "           \\",
    "  分支:     D---E---F",
    "",
    "PR 合并后:",
    "  main:  A---B---C---S       ← S 是新 commit，和 D/E/F 无关",
    "",
    "  分支:     D---E---F        ← 这 3 个仍在分支上，main 不认识",
    "```",
    "",
    "> 历史简洁，但丢失 commit 身份 → **会导致后续 PR 冲突**",
    "",
    "**原始命令:** `git checkout main && git merge --squash 分支 && git commit`",
  ].join("\n"),
  rebase: [
    "### Rebase（变基合并）",
    "",
    "```",
    "PR 合并前:",
    "  main:  A---B---C",
    "           \\",
    "  分支:     D---E---F",
    "",
    "PR 合并后:",
    "  main:  A---B---C---D'--E'--F'   ← 线性历史，commit 独立保留",
    "",
    "  分支:     D---E---F             ← 旧 commit 需手动同步 main",
    "```",
    "",
    "> 线性干净，commit 独立保留 → **推荐，不会导致后续冲突**",
    "",
    "**原始命令:** `git checkout 分支 && git rebase main && git checkout main && git merge 分支`",
  ].join("\n"),
};

/** TUI 选择合并策略，返回选中的 method 或 null（取消） */
function selectMethod(methods: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const items: SelectItem[] = methods.map((m) => ({
      value: m,
      label: m,
      description: MERGE_METHOD_DESC[m] ?? "",
    }));

    const listTheme: SelectListTheme = {
      selectedPrefix: (s) => `\x1b[1;36m${s}\x1b[0m`,
      selectedText:   (s) => `\x1b[1;36m${s}\x1b[0m`,
      description:    (s) => `\x1b[2m${s}\x1b[0m`,
      scrollInfo:     (s) => `\x1b[2m${s}\x1b[0m`,
      noMatch:        (s) => s,
    };

    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal, false);

    const container = new Container();
    container.addChild(new Text("\x1b[1m选择合并策略:\x1b[0m"));

    // 示意图 Markdown 组件，初始显示第一个选项的图
    const initialMethod = methods[0] ?? "merge";
    const diagramMd = new Markdown(
      MERGE_METHOD_DIAGRAM[initialMethod] ?? "",
      1, 0,
      plainTheme
    );

    const selectList = new SelectList(items, items.length, listTheme);
    selectList.onSelect = (item) => {
      tui.stop();
      resolve(item.value);
    };
    selectList.onCancel = () => {
      tui.stop();
      resolve(null);
    };
    // 切换选项时更新示意图
    selectList.onSelectionChange = (item) => {
      const diagram = MERGE_METHOD_DIAGRAM[item.value] ?? "";
      diagramMd.setText(diagram);
      tui.requestRender();
    };
    container.addChild(selectList);

    container.addChild(diagramMd);

    container.addChild(new Text("\x1b[2m↑↓ 选择  Enter 确认  Esc/q 取消\x1b[0m"));

    tui.addChild(container);
    tui.setFocus(selectList);
    tui.start();
  });
}

/** 构建当前分支的 ASCII 示意图（Markdown 代码块） */
function buildBranchDiagram(branch: string, mainBranch: string): string {
  const lines: string[] = [];
  lines.push("### 当前分支拓扑");
  lines.push("");
  lines.push("```");

  // 获取 merge-base
  let mergeBase = "?";
  try {
    mergeBase = getMergeBase(branch, mainBranch).slice(0, 7);
  } catch { /* ignore */ }

  // 分支上的 commit
  let branchCommits: string[] = [];
  try {
    const raw = run(`git log --oneline "${mergeBase}..${branch}"`);
    branchCommits = raw.split("\n").filter(Boolean).map((l) => l.slice(0, 7));
  } catch { /* ignore */ }

  // main 上的 commit（从 merge-base 往后取一段）
  let mainCommits: string[] = [];
  try {
    const raw = run(`git log --oneline "${mergeBase}..${mainBranch}"`);
    mainCommits = raw.split("\n").filter(Boolean).map((l) => l.slice(0, 7));
  } catch { /* ignore */ }

  const indent = "  ";

  // main 分支线
  if (mainCommits.length === 0) {
    lines.push(`${indent}main: ...---${mergeBase}`);
  } else {
    const mainChain = mainCommits.join("---");
    lines.push(`${indent}main: ...---${mergeBase}---${mainChain}`);
  }

  // 分支连接线
  const branchConnector = branchCommits.length > 0
    ? `\\\n${indent}${branch}:${indent}`
    : "";

  // 分支 commit 链
  const branchChain = branchCommits.join("---");
  lines.push(`${indent}     ${branchConnector}${branchChain}`);

  lines.push("```");
  lines.push("");
  lines.push(`> merge-base: \`${mergeBase}\` · ${branch} ahead ${branchCommits.length} · ${mainBranch} ahead ${mainCommits.length}`);

  return lines.join("\n");
}
