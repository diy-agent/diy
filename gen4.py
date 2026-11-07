"""按行号切 handler：`  binding.on(app.<域>.<path>, ...)` 到下一个 `  });`。"""
import re, sys
from pathlib import Path
IMPL = Path('apps/diy-app/src/main/services/api-impl.ts')
BASE = Path('apps/diy-app/src/main/services/api-domains')
lines = IMPL.read_text(encoding='utf-8').split('\n')
targets = set(sys.argv[1:])
handlers = []
i = 0
while i < len(lines):
    m = re.match(r'^  binding\.on\(app\.(\w+)\.([a-zA-Z0-9_.]+),\s*(.*)$', lines[i])
    if m and m.group(1) in targets:
        start = i
        if m.group(3).rstrip().endswith(');'):
            handlers.append((m.group(1), m.group(2), start, start)); i += 1; continue
        j = i + 1
        while j < len(lines) and lines[j] != '  });': j += 1
        if j >= len(lines):
            print(f'⚠ {m.group(1)}.{m.group(2)} 在行 {i+1} 找不到收尾'); i += 1; continue
        handlers.append((m.group(1), m.group(2), start, j)); i = j + 1; continue
    i += 1
by_dom = {}
for dom, path, s, e in handlers:
    by_dom.setdefault(dom, []).append((path, s, e))
for dom, entries in by_dom.items():
    out = []
    for path, s, e in entries:
        rest = lines[s][len(f'  binding.on(app.{dom}.{path}, '):]
        if s == e:
            key = f'"{path}"' if '.' in path else path
            body = rest.rstrip()
            if body.endswith(');'): body = body[:-2]
            out.append(f'        {key}: {body}')
        else:
            key = f'"{path}"' if '.' in path else path
            out.append(f'        {key}: {rest}')
            for k in range(s + 1, e):
                out.append('    ' + lines[k])
            out.append('        },')
    fn = 'bind' + dom[0].upper() + dom[1:]
    (BASE/dom/'impl.ts').write_text(
        f'/**\n * api-domains/{dom}/impl.ts —— `{dom}` 域的 handler\n *\n * 从 api-impl.ts 按**行号**切出（不依赖注释分组、不算字符偏移）。\n */\n'
        'import type { ServerBinding } from "@diy-agent/rpc";\n'
        f'import {{ {dom}Service }} from "./api";\n\n'
        f'export function {fn}(server: ServerBinding): void {{\n'
        f'    {dom}Service.bind(server, {{\n'
        + '\n'.join(out) + '\n'
        '    });\n}\n', encoding='utf-8')
    print(f'✓ {dom}/impl.ts（{len(entries)} 个）')
    # 删（从后往前）
    for path, s, e in sorted(entries, key=lambda x: -x[1]):
        lines[s:e+1] = [f'  // {dom}.{path} 已拆']
    cleaned, prev = [], None
    for l in lines:
        if l.startswith(f'  // {dom}.') and prev and prev.startswith(f'  // {dom}.'):
            prev = l; continue
        cleaned.append(l); prev = l
    lines = cleaned
IMPL.write_text('\n'.join(lines), encoding='utf-8')
