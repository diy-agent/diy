import { UserError } from "./errors.js";
import { ghIssueView, ghPrList, ghPrCreate, ghPrMerge, ghRepoMergeMethod } from "./github.js";
import {
  gitWorktreeList, gitWorktreeRemove, gitBranchDeleteForce, gitCheckout, gitPull, gitPush,
} from "./git.js";
import { parseIssueNumber, getCurrentBranch, getMainBranch, run } from "./helpers.js";
import type { WorktreeRow, PRInfo, IssueInfo } from "./types.js";
import { logger } from "../logger.js";
import { Markdown, type MarkdownTheme } from "@mariozechner/pi-tui";

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
      log.success(`成功: 已存在 open PR #${existing[0].number}`);
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

    // 交互模式：如果没指定 method，列出可用策略让用户选
    if (!method) {
      const availableMethods = ghRepoMergeMethod(this.repo);
      const methods = availableMethods.split(",");
      if (methods.length === 1) {
        method = methods[0];
      } else {
        // 优先 squash
        method = methods.includes("squash") ? "squash" : methods[0];
        log.info(`可用合并策略: ${methods.join(", ")}，使用: ${method}`);
      }
    }

    // 预检 mergeable 状态
    const prDetail = ghPrList(this.repo, branch, "open");
    if (prDetail.length > 0 && prDetail[0].mergeable === "CONFLICTING") {
      throw new UserError(`PR #${prNum} 有冲突，请在 Web 页面解决`);
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
