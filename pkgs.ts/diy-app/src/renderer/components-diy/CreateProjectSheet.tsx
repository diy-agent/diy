// src/renderer/components-diy/CreateProjectSheet.tsx
// 🎯 「创建项目」UI：任务树页顶部按钮 → 右侧滑出表单 → 创建并刷新树。
//    项目目录通过原生文件夹选择器选取（VSCode「添加文件夹到工作区」式），
//    不手填路径；提交逻辑与 ui.project.create RPC 共用 createProjectViaUi。

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { createProjectViaUi } from "./lib/create-project";
import { diyService } from "./lib/rpc";
import { useNotificationStore } from "./store/notificationStore";

/** 取路径末段作为默认显示名（~/git/my-repo → my-repo） */
function basename(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i === -1 ? t : t.slice(i + 1);
}

export function CreateProjectSheet() {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const addToast = useNotificationStore((s) => s.addToast);

  /** 弹原生文件夹选择器，选完自动填路径 + 自动补显示名 */
  const pickDir = async () => {
    try {
      const r = await diyService.diy.pickProjectDirectory({});
      if (r.data.canceled || !r.data.path) return;
      setPath(r.data.path);
      if (!label.trim()) setLabel(basename(r.data.path));
    } catch {
      /* 打开选择器失败/无 Electron dialog，忽略 */
    }
  };

  const submit = async () => {
    if (!path.trim()) {
      addToast("error", "请先选择项目目录");
      return;
    }
    setBusy(true);
    try {
      await createProjectViaUi(
        path.trim(),
        label.trim() || undefined,
        desc.trim() || undefined,
      );
      setOpen(false);
      setPath("");
      setLabel("");
      setDesc("");
    } catch (e) {
      addToast("error", `创建失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        ➕ 创建项目
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>创建项目</SheetTitle>
            <SheetDescription>
              选择要映射的目录（会在其中写 diy.yaml 名片），任务将聚合到该项目名下。
            </SheetDescription>
          </SheetHeader>

          <div className="flex flex-col gap-3 p-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">项目目录</label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  placeholder="未选择"
                  value={path}
                  className="flex-1"
                />
                <Button variant="outline" size="sm" onClick={pickDir}>
                  📂 选择目录…
                </Button>
              </div>
            </div>
            <Input
              placeholder="显示名称（缺省取目录名）"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <Input
              placeholder="描述（可选）"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
            />
          </div>

          <SheetFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button onClick={submit} disabled={busy || !path.trim()}>
              {busy ? "创建中…" : "创建"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}