"""dai task — 任务管理意图测试。

所有变更操作（add/create/edit）统一返回变更后的数据结构，
与 dai subject add 行为一致。

sh fixture 已激活 .venv（dai 直接可用）。
fake_home fixture 将 $HOME 隔离，~/ 路径在子进程内有效。
任务标识使用 URI（如 local/task/1），不再使用数字 ID。
"""

from __future__ import annotations

from pathlib import Path

from _shelltest import ShellTest


def test_intent_task_create_and_list(sh: ShellTest, fake_home: Path):
    """创建任务 → 列表可见。本地任务自动分配 URI。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/diy --desc "测试 subject"
        status: success
        data:
          path: ~/diy
          description: 测试 subject

        $ dai task create --title "实现dai task命令" --subject ~/diy
        status: success
        data:
          title: 实现dai task命令
          state: pending
          subject: ~/diy
          uri: local/task/1

        $ dai task create --title "实现dai edit命令" --subject ~/diy --parent local/task/1
        status: success
        data:
          title: 实现dai edit命令
          state: pending
          parent: local/task/1
          subject: ~/diy
          uri: local/task/2

        $ dai task list
        tasks:
          local/task/1:
            title: 实现dai task命令
            state: pending
            subject: ~/diy
          local/task/2:
            title: 实现dai edit命令
            state: pending
            parent: local/task/1
            subject: ~/diy
    """)


def test_intent_task_list_empty(sh: ShellTest, fake_home: Path):
    """无任务时列表为空。"""
    sh.assert_session("""
        $ dai task list
        tasks: {}
    """)


def test_intent_task_create_subject_validation(sh: ShellTest):
    """--subject 必须是已注册的 subject。未注册 → 报错。"""
    sh.assert_session("""
        $! dai task create --title "无主体" --subject ~/nonexistent
        *
    """)


def test_intent_task_show(sh: ShellTest, fake_home: Path):
    """查看单个任务。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/diy --desc "测试 subject"
        status: success
        data:
          path: ~/diy
          description: 测试 subject

        $ dai task create --title "待查看的任务" --subject ~/diy
        status: success
        data:
          title: 待查看的任务
          state: pending
          subject: ~/diy
          uri: local/task/1

        $ dai task show local/task/1
        title: 待查看的任务
        state: pending
        subject: ~/diy
    """)


def test_intent_task_edit_title(sh: ShellTest, fake_home: Path):
    """编辑任务标题。返回编辑后的完整字段。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/diy --desc "测试 subject"
        status: success
        data:
          path: ~/diy
          description: 测试 subject

        $ dai task create --title "旧标题" --subject ~/diy
        status: success
        data:
          title: 旧标题
          state: pending
          subject: ~/diy
          uri: local/task/1

        $ dai task edit local/task/1 --title "新标题"
        status: success
        data:
          title: 新标题
          state: pending
          subject: ~/diy

        $ dai task show local/task/1
        title: 新标题
        state: pending
    """)


def test_intent_task_edit_subject(sh: ShellTest, fake_home: Path):
    """编辑任务 subject（新 subject 必须已注册）。"""
    (fake_home / "alpha").mkdir()
    (fake_home / "alpha" / ".git").touch()
    (fake_home / "beta").mkdir()
    (fake_home / "beta" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/alpha --desc alpha
        status: success
        data:
          path: ~/alpha
          description: alpha

        $ dai subject add ~/beta --desc beta
        status: success
        data:
          path: ~/beta
          description: beta

        $ dai task create --title "迁移任务" --subject ~/alpha
        status: success
        data:
          title: 迁移任务
          state: pending
          subject: ~/alpha
          uri: local/task/1

        $ dai task edit local/task/1 --subject ~/beta
        status: success
        data:
          title: 迁移任务
          state: pending
          subject: ~/beta

        $ dai task show local/task/1
        title: 迁移任务
        subject: ~/beta
    """)


def test_intent_task_edit_state(sh: ShellTest, fake_home: Path):
    """编辑任务状态字段。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/diy --desc "测试 subject"
        status: success
        data:
          path: ~/diy
          description: 测试 subject

        $ dai task create --title "改状态" --subject ~/diy
        status: success
        data:
          title: 改状态
          state: pending
          subject: ~/diy
          uri: local/task/1

        $ dai task edit local/task/1 --state active
        status: success
        data:
          title: 改状态
          state: active
          subject: ~/diy

        $ dai task show local/task/1
        title: 改状态
        state: active
    """)


def test_intent_task_edit_parent(sh: ShellTest, fake_home: Path):
    """编辑父任务。返回编辑后的完整字段。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/diy --desc "测试 subject"
        status: success
        data:
          path: ~/diy
          description: 测试 subject

        $ dai task create --title "父任务" --subject ~/diy
        status: success
        data:
          title: 父任务
          state: pending
          subject: ~/diy
          uri: local/task/1

        $ dai task create --title "独立任务" --subject ~/diy
        status: success
        data:
          title: 独立任务
          state: pending
          subject: ~/diy
          uri: local/task/2

        $ dai task edit local/task/2 --parent local/task/1
        status: success
        data:
          title: 独立任务
          state: pending
          parent: local/task/1
          subject: ~/diy

        $ dai task show local/task/2
        title: 独立任务
        parent: local/task/1
    """)


def test_intent_task_edit_parent_validation(sh: ShellTest, fake_home: Path):
    """parent 不存在 → 报错。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/diy --desc "测试 subject"
        status: success
        data:
          path: ~/diy
          description: 测试 subject

        $ dai task create --title "孤儿" --subject ~/diy
        status: success
        data:
          title: 孤儿
          state: pending
          subject: ~/diy
          uri: local/task/1

        $! dai task edit local/task/1 --parent local/task/9999
        *
    """)


def test_intent_task_delete(sh: ShellTest, fake_home: Path):
    """删除任务。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/diy --desc "测试 subject"
        status: success
        data:
          path: ~/diy
          description: 测试 subject

        $ dai task create --title "临时任务" --subject ~/diy
        status: success
        data:
          title: 临时任务
          state: pending
          subject: ~/diy
          uri: local/task/1

        $ dai task delete local/task/1
        status: success

        $ dai task list
        tasks: {}
    """)


def test_intent_task_json_output(sh: ShellTest, fake_home: Path):
    """--json 标志使各子命令输出 JSON。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/diy --desc "测试 subject"
        status: success
        data:
          path: ~/diy
          description: 测试 subject

        $ dai task create --title "JSON测试" --subject ~/diy --json
        {{regex:.*title.*JSON测试.*}}

        $ dai task list --json
        {{regex:.*tasks.*}}

        $ dai task show local/task/1 --json
        {{regex:.*title.*JSON测试.*}}
    """)


def test_intent_task_show_missing(sh: ShellTest):
    """操作不存在的任务 → 报错。"""
    sh.assert_session("""
        $! dai task show local/task/9999
        *
    """)


def test_intent_task_edit_missing(sh: ShellTest):
    """编辑不存在的任务 → 报错。"""
    sh.assert_session("""
        $! dai task edit local/task/9999 --title "不存在"
        *
    """)


def test_intent_task_delete_missing(sh: ShellTest):
    """删除不存在的任务 → 报错。"""
    sh.assert_session("""
        $! dai task delete local/task/9999
        *
    """)


def test_intent_task_create_missing_title(sh: ShellTest):
    """创建任务缺标题 → 报错。"""
    sh.assert_session("""
        $! dai task create
        *
    """)


def test_intent_task_list_sort(sh: ShellTest, fake_home: Path):
    """列表按 URI 字典序输出。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/diy --desc "测试 subject"
        status: success
        data:
          path: ~/diy
          description: 测试 subject

        $ dai task create --title "任务A" --subject ~/diy
        status: success
        data:

        $ dai task create --title "任务B" --subject ~/diy
        status: success
        data:

        $ dai task create --title "任务C" --subject ~/diy
        status: success
        data:

        $ dai task list
        tasks:
          local/task/1:
            title: 任务A
          local/task/2:
            title: 任务B
          local/task/3:
            title: 任务C
    """)


def test_intent_task_edit_multiple_fields(sh: ShellTest, fake_home: Path):
    """一次编辑多个字段。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/diy --desc "测试 subject"
        status: success
        data:
          path: ~/diy
          description: 测试 subject

        $ dai task create --title "原始" --subject ~/diy
        status: success
        data:
          title: 原始
          state: pending
          subject: ~/diy
          uri: local/task/1

        $ dai task edit local/task/1 --title "更新后" --state active
        status: success
        data:
          title: 更新后
          state: active
          subject: ~/diy

        $ dai task show local/task/1
        title: 更新后
        state: active
        subject: ~/diy
    """)


def test_intent_task_create_subject_not_found(sh: ShellTest, fake_home: Path):
    """创建任务时 subject 不存在 → 返回全部收集的错误。"""
    sh.assert_session("""
        $ dai task create --title "任务" --subject ~/nonexistent
        ---
        *subject*not_found*
    """)


def test_intent_task_create_title_empty(sh: ShellTest, fake_home: Path):
    """创建任务时标题为空 → 收集错误。"""
    (fake_home / "git").mkdir()
    (fake_home / "git" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/git --desc "测试"
        status: success

        $ dai task create --title "" --subject ~/git
        ---
        *title*required*
    """)


def test_intent_task_create_parent_not_found(sh: ShellTest, fake_home: Path):
    """创建任务时 parent URI 不存在 → 收集错误。"""
    (fake_home / "git").mkdir()
    (fake_home / "git" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/git --desc "测试"
        status: success

        $ dai task create --title "新任务" --subject ~/git --parent local/task/999
        ---
        *parent*not_found*
    """)


def test_intent_task_create_multiple_errors(sh: ShellTest, fake_home: Path):
    """创建任务时多个参数同时错误 → 一次返回全部错误（不短路）。"""
    sh.assert_session("""
        $ dai task create --title "" --subject ~/nonexistent --parent local/task/999
        ---
        *title*required*
        *subject*not_found*
        *parent*not_found*
    """)


def test_intent_task_create_body_file_not_found(sh: ShellTest, fake_home: Path):
    """创建任务时 body_file 路径无效 → 收集错误。"""
    (fake_home / "git").mkdir()
    (fake_home / "git" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/git --desc "测试"
        status: success

        $ dai task create --title "正文导入" --subject ~/git --body-file /nonexistent/foo.md
        ---
        *body_file*read_error*
    """)
