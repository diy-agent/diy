import { diyService } from "./rpc";
import { taskStore } from "../store/taskStore";
import { notificationStore } from "../store/notificationStore";

export async function createProjectViaUi(path: string, label?: string, desc?: string): Promise<string> {
  const r = await diyService.diy.project.create({ path, label, desc, state: undefined });
  const id = r.data.id;
  await taskStore.loadTree();
  notificationStore.addToast("success", `已创建项目 #${id}`);
  return id;
}
