#!/bin/bash
# Antigravity 2.32.1（macOS ARM64）客户端 free-tier 检查补丁
#
# 用法:
#   ./antigravity-unlock.sh                 # 生成 /Applications/Antigravity Patched.app
#   ./antigravity-unlock.sh --stage-only    # 在临时目录生成打好补丁的副本
#   ./antigravity-unlock.sh --from /path/to/Antigravity.app   # 指定源 bundle
#   ./antigravity-unlock.sh --app /path/to/Antigravity-Patched.app   # 指定输出路径
#
set -euo pipefail

APP="/Applications/Antigravity Patched.app"
SRC=""
STAGE_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage-only) STAGE_ONLY=1; shift ;;
    --from) SRC="$2"; shift 2 ;;
    --app) APP="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$SRC" ]]; then
  if [[ -d "/Applications/Antigravity.app.orig" ]]; then
    SRC="/Applications/Antigravity.app.orig"
  else
    SRC="/Applications/Antigravity.app"
  fi
fi
[[ -d "$SRC" ]] || { echo "找不到 app: $SRC" >&2; exit 1; }
if [[ $STAGE_ONLY -eq 0 && ( -e "$APP" || -L "$APP" ) ]]; then
  echo "输出路径已存在，请用 --app 指定新路径: $APP" >&2
  exit 1
fi

WORK="$(mktemp -d /tmp/agy-unlock.XXXXXX)"
STAGE="$WORK/Antigravity Patched.app"
echo "==> 复制 $SRC -> $STAGE"
cp -R -p "$SRC" "$STAGE"

echo "==> 打补丁"
python3 - "$STAGE/Contents/Resources/bin/language_server" <<'PY'
import struct, sys, os, hashlib

path = sys.argv[1]
data = bytearray(open(path, 'rb').read())

EXPECTED_SHA256 = 'f5377993d29bc1036ed9ddbfb2aec55bb37b8aaaf811df4a8c3ed5763dde2db0'
if hashlib.sha256(data).hexdigest() != EXPECTED_SHA256:
    sys.exit("仅支持已核验的 Antigravity 2.32.1 ARM64 原始文件；当前文件不匹配，停止处理")

# pclntab: magic 0xFFFFFFF1 (go >= 1.20) / 0xFFFFFFF0
cands = []
for magic in (0xFFFFFFF1, 0xFFFFFFF0):
    pat = struct.pack('<I', magic) + b'\x00\x00'
    s = 0
    while True:
        i = data.find(pat, s)
        if i < 0:
            break
        cands.append((i, magic)); s = i + 1

funcs = None
for i, magic in cands:
    try:
        nfunc, = struct.unpack('<Q', data[i+8:i+16])
        textStart, fnOff, cuOff, ftOff, pcOff, pclnOff = struct.unpack('<QQQQQQ', data[i+24:i+72])
    except Exception:
        continue
    if not (0 < nfunc < 500000 and 0 < pclnOff < len(data)):
        continue
    # __text 起点 = file offset of section (从 0xf80 附近开始); 用第一个函数反推
    functab = i + pclnOff
    fnname = i + fnOff
    table = []
    for k in range(nfunc):
        entryoff, funcoff = struct.unpack('<II', data[functab+k*8: functab+k*8+8])
        fo = functab + funcoff
        nameoff, = struct.unpack('<i', data[fo+4:fo+8])
        ns = fnname + nameoff
        ne = data.find(b'\x00', ns)
        table.append((entryoff, data[ns:ne].decode('utf8', 'replace')))
    funcs = (i, table)
    break

if not funcs:
    sys.exit("找不到 Go pclntab，版本可能变了")

hdr, table = funcs
# 函数地址 = __text 起始 + entryoff。用第一个函数（entryoff=0）的 prologue
# 'ldr x16,[x28,#0x10]' (50 00 40 f9 之类) 反查 __text 的文件偏移。
# Go 的栈分裂 prologue 首指令固定为 ldr x16,[x28,#0x10] = 0xf9400fd0-ish
first_off, first_name = table[0]
if first_name != 'internal/abi.(*RegArgs).Dump':
    print(f"  注意: 首个符号为 {first_name}")
# 直接猜 __text 文件偏移：Mach-O 中 __text 紧随 header+load commands，通常在 0xf80
# 用候选值校验首条指令是否为 ldr x16,[x28,#0x10]
text_off = None
for cand in range(0x400, 0x4000, 4):
    w, = struct.unpack('<I', data[cand:cand+4])
    # ldr x16, [x28, #imm]  ->  0xF9400000 | (imm12<<10) | (28<<5) | 16
    if (w & 0xFFC0001F) == (0xF9400000 | 16) and ((w >> 5) & 0x1f) == 28:
        text_off = cand
        break
if text_off is None:
    sys.exit("找不到 __text 起点")

target = 'authclient.ValidateAndOnboardAccount'
hit = [(o, n) for (o, n) in table if n.endswith(target)]
if not hit:
    sys.exit(f"函数表中找不到 {target}")

entryoff, name = hit[0]
start = text_off + entryoff
# 函数长度：下一个函数的 entryoff
nxt = min((o for (o, _) in table if o > entryoff), default=entryoff + 0x2000)
end = text_off + nxt
print(f"  找到 {name.split('/')[-1]} @ file offset 0x{start:x} (len 0x{end-start:x})")

# 核对 "cmp x8, #9" + 紧随的 b.ne（跳回循环，继续下一项）
CMP_X8_9 = 0xf100251f
spots = []
# 2.32.1: IneligibleTier.TierId 检查位于函数内 0x294；文件摘要已在上方核验。
for off in (start + 0x294,):
    w, = struct.unpack('<I', data[off:off+4])
    if w != CMP_X8_9:
        continue
    b, = struct.unpack('<I', data[off+4:off+8])
    if (b & 0xfc000000) != 0x54000000:      # b.cond
        continue
    imm19 = (b >> 5) & 0x7ffff
    if imm19 >= (1 << 18):
        imm19 -= (1 << 19)
    tgt = off + 4 + imm19 * 4
    if tgt < off:                            # 向前跳 = 跳过本 tier
        spots.append((off + 4, b, tgt))

if len(spots) != 1:
    sys.exit(f"期望命中 1 处，实际 {len(spots)} 处；版本可能变了，需人工确认")

b_off, b_word, tgt = spots[0]
# 无条件 b：opcode 0x14000000 | imm26
off26 = (tgt - b_off) // 4
if off26 < -(1 << 25) or off26 >= (1 << 25):
    sys.exit("分支距离超出范围")
new = 0x14000000 | (off26 & 0x03ffffff)
data[b_off:b_off+4] = struct.pack('<I', new)
open(path, 'wb').write(data)
print(f"  patched: file 0x{b_off:x}  {b_word:#010x}(b.cond) -> {new:#010x}(b)  target 0x{tgt:x}")
PY

LS="$STAGE/Contents/Resources/bin/language_server"
ENT_APP="$WORK/app.entitlements"
ENT_LS="$WORK/ls.entitlements"
codesign -d --entitlements - --xml "$STAGE"      2>/dev/null > "$ENT_APP" || true
codesign -d --entitlements - --xml "$LS"         2>/dev/null > "$ENT_LS"  || true
[[ -s "$ENT_APP" ]] || printf '%s' '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>' > "$ENT_APP"
[[ -s "$ENT_LS"  ]] || printf '%s' '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>' > "$ENT_LS"

echo "==> 重新签名"
codesign --force --sign - --options runtime --entitlements "$ENT_LS"  "$LS"
# 外层不能用 --options runtime，否则库校验会拒绝 Google 签名的 Electron Framework
codesign --force --sign - --entitlements "$ENT_APP" "$STAGE"
codesign --verify --strict "$STAGE" || { echo "签名校验失败" >&2; exit 1; }

if [[ $STAGE_ONLY -eq 1 ]]; then
  echo "==> 完成（--stage-only）: $STAGE"
  exit 0
fi

echo "==> 保存应用副本"
[[ ! -e "$APP" && ! -L "$APP" ]] || { echo "输出路径已存在: $APP" >&2; exit 1; }
mv "$STAGE" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "完成。应用副本: $APP"
echo "两个应用共用登录和设置，请先退出当前 Antigravity，再打开: $APP"
