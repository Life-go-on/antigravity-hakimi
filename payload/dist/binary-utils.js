'use strict';
/**
 * Shared low-level binary helpers for 哈基米.app region unlock engines
 * (Mach-O / ELF64 Go .gopclntab scanning and adaptive ARM64 ValidateAndOnboardAccount branch analysis).
 */

const crypto = require('crypto');

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function signExtend(val, bits) {
  const shift = 32 - bits;
  return (val << shift) >> shift;
}

function readCString(buf, start, maxLen = 2048) {
  if (start < 0 || start >= buf.length) return '';
  let end = buf.indexOf(0, start);
  if (end < 0 || end - start > maxLen) {
    end = Math.min(buf.length, start + maxLen);
  }
  return buf.subarray(start, end).toString('utf8');
}

function decodeArm64BneTarget(word, instrOffset) {
  if (((word & 0xff00001f) >>> 0) !== 0x54000001) return null;
  const imm19 = signExtend((word >> 5) & 0x7ffff, 19);
  return instrOffset + imm19 * 4;
}

function decodeArm64CondBranchTarget(word, instrOffset) {
  if (((word & 0xff000010) >>> 0) !== 0x54000000) return null;
  const imm19 = signExtend((word >> 5) & 0x7ffff, 19);
  return instrOffset + imm19 * 4;
}

function decodeArm64UncondBranchTarget(word, instrOffset) {
  if (((word & 0xfc000000) >>> 0) !== 0x14000000) return null;
  const imm26 = signExtend(word & 0x03ffffff, 26);
  return instrOffset + imm26 * 4;
}

/**
 * Scan Go .gopclntab (Go 1.18+ 0xFFFFFFF0 / Go 1.20+ 0xFFFFFFF1) for target function suffixes.
 * @param {Buffer} buf
 * @param {string[]} targetSuffixes
 * @param {{ minLC?: number, maxNfunc?: number, resolveBase?: (pclnOff: number, textStart: number) => { goTextOff: number, goTextVA?: number, source?: string } }} [options]
 */
function scanGopclntabBySuffix(buf, targetSuffixes, options = {}) {
  const minLC = options.minLC ?? 0x04;
  const maxNfunc = options.maxNfunc ?? 500000;
  const suffixes = Array.isArray(targetSuffixes) ? targetSuffixes : [targetSuffixes];
  const magics = [
    Buffer.from([0xf1, 0xff, 0xff, 0xff, 0x00, 0x00, minLC, 0x08]),
    Buffer.from([0xf0, 0xff, 0xff, 0xff, 0x00, 0x00, minLC, 0x08]),
  ];

  let foundPcln = false;
  for (const pat of magics) {
    let pos = 0;
    while (pos >= 0 && pos < buf.length) {
      const i = buf.indexOf(pat, pos);
      if (i < 0) break;
      pos = i + 4;
      if (i + 72 > buf.length) continue;

      const nfunc = Number(buf.readBigUInt64LE(i + 8));
      const textStart = Number(buf.readBigUInt64LE(i + 24));
      const fnOff = Number(buf.readBigUInt64LE(i + 32));
      const pclnOff = Number(buf.readBigUInt64LE(i + 64));

      if (!(nfunc >= 1 && nfunc < maxNfunc)) continue;
      const functab = i + pclnOff;
      const fnname = i + fnOff;
      if (pclnOff <= 0 || fnOff <= 0 || functab + (nfunc + 1) * 8 > buf.length || fnname >= buf.length) {
        continue;
      }

      foundPcln = true;
      const base =
        typeof options.resolveBase === 'function'
          ? options.resolveBase(i, textStart)
          : { goTextOff: options.textOff || 0, goTextVA: options.textVA || 0, source: 'explicit' };
      const found = Object.create(null);
      let foundCount = 0;

      for (let k = 0; k < nfunc; k++) {
        const entryOff = buf.readUInt32LE(functab + k * 8);
        const funcOff = buf.readUInt32LE(functab + k * 8 + 4);
        const fo = functab + funcOff;
        if (fo + 8 > buf.length) continue;
        const nameOff = buf.readInt32LE(fo + 4);
        if (nameOff < 0 || fnname + nameOff >= buf.length) continue;
        const name = readCString(buf, fnname + nameOff);

        for (const suf of suffixes) {
          if (
            !found[suf] &&
            (name === suf || name.endsWith('/' + suf) || name.endsWith('.' + suf))
          ) {
            const nextEntryOff = buf.readUInt32LE(functab + (k + 1) * 8);
            const size = nextEntryOff > entryOff ? nextEntryOff - entryOff : 0;
            found[suf] = {
              name,
              entryOff,
              nextEntryOff,
              size,
              fnStart: base.goTextOff + entryOff,
              fnEnd: base.goTextOff + nextEntryOff,
              fnVA: (base.goTextVA || 0) + entryOff,
            };
            foundCount++;
          }
        }
        if (foundCount >= suffixes.length) break;
      }

      return {
        foundPcln: true,
        pclnOff: i,
        nfunc,
        goTextVA: base.goTextVA || 0,
        goTextOff: base.goTextOff,
        goTextSource: base.source || 'explicit',
        funcs: found,
      };
    }
  }

  return { foundPcln, funcs: Object.create(null) };
}

/**
 * Shared adaptive ARM64 instruction-pattern analyzer for authclient.ValidateAndOnboardAccount.
 * Distinguishes allowedTiers (BREAK_ONLY) vs ineligibleTiers (HAS_MATCH_BODY) loops across
 * both macOS Mach-O ARM64 and Linux ELF64 ARM64 binaries.
 */
function analyzeArm64RegionInRange(buf, fnStart, fnEnd, fnName) {
  let hasFreeTieConst = false;
  for (let p = fnStart; p <= fnEnd - 4; p += 4) {
    const w = buf.readUInt32LE(p);
    if (((w & 0x7fffffe0) >>> 0) === 0x528e4cc0) {
      hasFreeTieConst = true;
      break;
    }
  }

  const candidates = [];
  for (let p = fnStart; p <= fnEnd - 20; p += 4) {
    const w0 = buf.readUInt32LE(p);
    // cmp xN/wN, #9 (length of "free-tier")
    if (((w0 & 0x7ffffc1f) >>> 0) !== 0x7100241f) continue;

    const w1 = buf.readUInt32LE(p + 4);
    let T = decodeArm64BneTarget(w1, p + 4);
    let state = null;
    if (T !== null) {
      state = 'unpatched';
    } else {
      T = decodeArm64UncondBranchTarget(w1, p + 4);
      if (T !== null) state = 'patched';
    }
    if (T === null || T < fnStart || T >= p) continue;

    // Locate stage-3 tail check: cmp wM/xM, #0x72 ('r') ; b.ne T within [p+8, p+0x48)
    let tailEnd = null;
    let interBneCount = 0;
    const searchLimit = Math.min(fnEnd - 8, p + 0x48);
    for (let q = p + 8; q <= searchLimit; q += 4) {
      const wq0 = buf.readUInt32LE(q);
      const wq1 = buf.readUInt32LE(q + 4);
      if (((wq0 & 0x7ffffc1f) >>> 0) === 0x7101c81f) {
        const qt = decodeArm64BneTarget(wq1, q + 4);
        if (qt === T) {
          tailEnd = q + 8;
          break;
        }
      }
      if (decodeArm64BneTarget(wq0, q) === T) {
        interBneCount++;
      }
    }
    if (tailEnd === null || interBneCount < 1) continue;

    // Inspect loop-exit branches inside [T, min(p, T + 0x30))
    const loopExits = [];
    const loopScanEnd = Math.min(p, T + 0x30);
    for (let r = T; r < loopScanEnd; r += 4) {
      const wr = buf.readUInt32LE(r);
      const dest = decodeArm64CondBranchTarget(wr, r);
      if (dest !== null && dest >= tailEnd) {
        loopExits.push({ offset: r, dest });
      }
    }
    if (loopExits.length === 0) continue;

    const hasMatchBody = loopExits.some((e) => e.dest > tailEnd);
    const isBreakOnly = loopExits.every((e) => e.dest === tailEnd);
    candidates.push({ p, w0, w1, T, tailEnd, state, loopExits, hasMatchBody, isBreakOnly });
  }

  const ineligible = candidates.filter((c) => c.hasMatchBody);
  const allowed = candidates.filter((c) => c.isBreakOnly && !c.hasMatchBody);

  if (ineligible.length === 0) {
    return {
      ok: false,
      status: 'pattern_missing',
      code: 'PATTERN_NOT_FOUND',
      fnName,
      fnStart,
      fnEnd,
      hasFreeTieConst,
      allowedTiersCount: allowed.length,
      error: `在 ${fnName} 中未找到 free-tier 地区限制分支，新版反重力可能已移除或重构该逻辑`,
    };
  }

  if (ineligible.length > 1) {
    return {
      ok: false,
      status: 'ambiguous',
      code: 'AMBIGUOUS_MATCH',
      fnName,
      fnStart,
      fnEnd,
      error: `在 ValidateAndOnboardAccount 中命中 ${ineligible.length} 处候选分支，为安全起见停止处理`,
    };
  }

  if (allowed.some((c) => c.state !== 'unpatched')) {
    return {
      ok: false,
      status: 'corrupted_allowed_tiers',
      code: 'ALLOWED_TIERS_MODIFIED',
      fnName,
      error: '检测到 allowedTiers 循环被意外修改',
    };
  }

  const hit = ineligible[0];
  const branchOffset = hit.p + 4;
  const off26 = (hit.T - branchOffset) / 4;
  if (!Number.isInteger(off26) || off26 < -(1 << 25) || off26 >= (1 << 25)) {
    return {
      ok: false,
      status: 'out_of_range',
      code: 'BRANCH_OUT_OF_RANGE',
      fnName,
      error: '地区解锁跳转分支距离超出 ARM64 b 指令范围',
    };
  }

  const patchedWord = (0x14000000 | (off26 & 0x03ffffff)) >>> 0;
  const patchedBytes = Buffer.alloc(4);
  patchedBytes.writeUInt32LE(patchedWord, 0);

  return {
    ok: true,
    arch: 'arm64',
    status: hit.state,
    fnName,
    fnStart,
    fnEnd,
    cmpOffset: hit.p,
    branchOffset,
    branchLength: 4,
    relOffsetInFn: hit.p - fnStart,
    targetOffset: hit.T,
    currentWord: hit.w1 >>> 0,
    patchedWord,
    currentBytes: Buffer.from(buf.subarray(branchOffset, branchOffset + 4)),
    patchedBytes,
    allowedTiersCount: allowed.length,
    hasFreeTieConst,
  };
}

module.exports = {
  sha256Buffer,
  signExtend,
  readCString,
  decodeArm64BneTarget,
  decodeArm64CondBranchTarget,
  decodeArm64UncondBranchTarget,
  scanGopclntabBySuffix,
  analyzeArm64RegionInRange,
};
