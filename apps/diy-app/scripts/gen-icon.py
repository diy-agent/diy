#!/usr/bin/env python3
"""gen-icon.py — 生成应用图标（macOS 开发用）"""

import struct, zlib, subprocess, sys
from pathlib import Path

def make256():
    W = 256
    cx = cy = W // 2
    r, ir = W // 2 - 20, W // 6
    def ck(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    raw = b''
    for y in range(W):
        raw += b'\x00'
        for x in range(W):
            d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            if d < r and d > ir:
                raw += bytes((122, 162, 247, 255))
            elif d <= ir:
                raw += bytes((30, 30, 46, 255))
            else:
                raw += bytes((0, 0, 0, 0))
    return b'\x89PNG\r\n\x1a\n' + ck(b'IHDR', struct.pack('>IIBBBBB', W, W, 8, 6, 0, 0, 0)) + ck(b'IDAT', zlib.compress(raw)) + ck(b'IEND', b'')

def main():
    root = Path(__file__).resolve().parent.parent / 'build'
    iconset = root / 'icon.iconset'
    iconset.mkdir(parents=True, exist_ok=True)

    base = '/tmp/__diy_icon.png'
    with open(base, 'wb') as f:
        f.write(make256())

    for size in (16, 32, 64, 128, 256):
        subprocess.run(['sips', '-z', str(size), str(size), base, '--out', str(iconset / f'icon_{size}x{size}.png')],
                       capture_output=True)

    # @2x variants
    import shutil
    shutil.copy(iconset / 'icon_32x32.png', iconset / 'icon_16x16@2x.png')
    shutil.copy(iconset / 'icon_64x64.png', iconset / 'icon_32x32@2x.png')
    shutil.copy(iconset / 'icon_256x256.png', iconset / 'icon_128x128@2x.png')
    subprocess.run(['sips', '-z', '512', '512', base, '--out', str(iconset / 'icon_256x256@2x.png')], capture_output=True)
    subprocess.run(['sips', '-z', '1024', '1024', base, '--out', str(iconset / 'icon_512x512@2x.png')], capture_output=True)
    shutil.copy(iconset / 'icon_256x256@2x.png', iconset / 'icon_512x512.png')

    subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(root / 'icon.icns')], check=True)
    shutil.copy(iconset / 'icon_512x512.png', root / 'icon.png')
    print(f'✓ icons in {root}')

if __name__ == '__main__':
    main()
