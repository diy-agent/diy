import re, subprocess
from pathlib import Path
API = Path('apps/diy-app/src/main/services/api-impl.ts')
src = API.read_text(encoding='utf-8')
mapping = {}
for m in re.finditer(r'^import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*"([^"]+)"', src, re.M | re.S):
    for raw in m.group(1).split(','):
        n = raw.strip().split(' as ')[0].strip()
        if n: mapping[n] = m.group(2)
for m in re.finditer(r'^import\s+\*\s+as\s+(\w+)\s+from\s*"([^"]+)"', src, re.M):
    mapping[m.group(1)] = m.group(2)
out = subprocess.run(['node_modules/.bin/tsc','-p','apps/diy-app/tsconfig.json','--noEmit'], capture_output=True, text=True).stdout
missing = {}
for line in out.split('\n'):
    m = re.match(r'(.+?api-domains/\w+/impl\.ts)\(\d+,\d+\): error TS2304: Cannot find name \'(\w+)\'', line)
    if m: missing.setdefault(m.group(1), set()).add(m.group(2))
def relocate(mod):
    if not mod.startswith('.'): return mod
    return '../../' + mod.lstrip('./')
for f, names in missing.items():
    p = Path(f); s = p.read_text(encoding='utf-8')
    by_mod = {}
    for n in names:
        mod = mapping.get(n)
        if mod is None:
            print(f'  ⚠ {Path(f).parent.name}: {n}'); continue
        by_mod.setdefault(relocate(mod), []).append(n)
    lines = [f'import {{ {", ".join(v)} }} from "{k}";' for k, v in by_mod.items()]
    anchor = f'import {{ {Path(f).parent.name}Service }} from "./api";'
    s = s.replace(anchor, anchor + '\n' + '\n'.join(lines), 1)
    p.write_text(s, encoding='utf-8')
    print(f'  ✓ {Path(f).parent.name} 补 {len(names)}')
