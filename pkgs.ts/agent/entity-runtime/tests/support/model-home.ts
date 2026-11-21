// 临时模型目录 —— 几个测试要一份「不依赖开发机 ~/.diy」的 model.yaml。
//
// 为什么必须隔离：`maxOutputTokensOf` / `modelOf` 现在**真读目录**（`@diy-agent/model-catalog`）。
// 用真数据根跑单测 = 断言结果跟着开发机的配置变（今天 4096、明天换个账号就红）。
// 目录口径与生产一致：`model.yaml` + `providers.custom.yaml` 同目录（见 `providers.ts::modelHome`）。

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 两个 provider 故意共用同一个 modelId（`fast`）—— 证明查找是 provider + model 双匹配 */
const MODEL_YAML = `defaultModel: main@acme/fast
customProviders:
  acme:
    accounts:
      - type: apiKey
        name: main
        data:
          value: sk-acme-1234
  other:
    accounts:
      - type: apiKey
        name: main
        data:
          value: sk-other-5678
`;

const PROVIDERS_CUSTOM_YAML = `acme:
  id: acme
  npm: '@ai-sdk/openai-compatible'
  api: https://acme.example/v1
  models:
    fast:
      id: fast
      name: Acme Fast
      limit:
        context: 128000
        output: 4096
other:
  id: other
  npm: '@ai-sdk/openai-compatible'
  api: https://other.example/v1
  models:
    fast:
      id: fast
      name: Other Fast
      limit:
        context: 8000
        output: 512
`;

export interface ModelHome {
    /** 目录根（喂给 `DIY_MODEL_CONFIG` 的是 `<home>/model.yaml`） */
    readonly home: string;
    readonly configPath: string;
    /** 用完还原 env（不是删变量 —— 开发机可能本来就有） */
    readonly restore: () => void;
}

/**
 * 建一份临时目录并把 `DIY_MODEL_CONFIG` 指过去。
 *
 * 用 `DIY_MODEL_CONFIG` 而不是 `DIY_HOME`：前者是 diy2 实际用的那一档（`server/config.ts` 装配），
 * 后者会连带影响别的读 `DIY_HOME` 的东西。
 */
export function useModelHome(): ModelHome {
    const home = mkdtempSync(join(tmpdir(), 'diy2-model-'));
    writeFileSync(join(home, 'model.yaml'), MODEL_YAML);
    writeFileSync(join(home, 'providers.custom.yaml'), PROVIDERS_CUSTOM_YAML);
    const configPath = join(home, 'model.yaml');
    const previous = process.env['DIY_MODEL_CONFIG'];
    process.env['DIY_MODEL_CONFIG'] = configPath;
    const restore = (): void => {
        if (previous === undefined) delete process.env['DIY_MODEL_CONFIG'];
        else process.env['DIY_MODEL_CONFIG'] = previous;
    };
    return { home, configPath, restore };
}
