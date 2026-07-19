// tests/helper.ts
// 🎯 测试辅助工具：在测试临时目录下构建模拟 ~/.diy/ 目录结构
//    DIY_HOME 由 setup.ts 设为 /tmp/diy-desktop-test-xxx/，安全无忧

import * as yaml from "js-yaml";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../src/main/core/state";

/**
 * 在测试临时目录下创建 ~/.diy/state.yaml
 */
export function createStateYaml(data: Record<string, unknown>): string {
  const home = diyHome();
  mkdirSync(home, { recursive: true });
  const p = join(home, "state.yaml");
  writeFileSync(p, yaml.dump(data, { indent: 2, noRefs: true }), "utf-8");
  return p;
}

/**
 * 在测试临时目录下创建一条任务 AGENTS.md
 * 返回任务 URI
 */
export function createTaskFile(params: {
  uri: string;
  title?: string;
  state?: string;
  subject?: string;
  body?: string;
}): string {
  const { uri, title, state, subject, body } = params;
  const home = diyHome();
  const taskPath = join(home, "task", uri, "AGENTS.md");
  mkdirSync(join(home, "task", uri), { recursive: true });

  const front: Record<string, string | undefined> = { title, state, subject };
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(front)) {
    if (v !== undefined) cleaned[k] = v;
  }

  const fm = yaml.dump(cleaned, { indent: 2, noRefs: true });
  writeFileSync(taskPath, `---\n${fm}---\n${body ?? ""}`, "utf-8");
  return uri;
}
