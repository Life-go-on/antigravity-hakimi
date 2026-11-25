'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const cli = require(path.join(ROOT, 'payload', 'dist', 'meter-cli-unlock.js'));

function writeElfSectionHeader(buf, offset, { nameOff, type, flags, addr, fileOff, size, entsize = 0 }) {
  buf.writeUInt32LE(nameOff, offset + 0);
  buf.writeUInt32LE(type, offset + 4);
  buf.writeBigUInt64LE(BigInt(flags), offset + 8);
  buf.writeBigUInt64LE(BigInt(addr), offset + 16);
  buf.writeBigUInt64LE(BigInt(fileOff), offset + 24);
  buf.writeBigUInt64LE(BigInt(size), offset + 32);
  buf.writeUInt32LE(0, offset + 40);
  buf.writeUInt32LE(0, offset + 44);
  buf.writeBigUInt64LE(8n, offset + 48);
  buf.writeBigUInt64LE(BigInt(entsize), offset + 56);
}

/**
 * Build a synthetic Linux ELF64 x86-64 PIE agy CLI binary with:
 * - .text at 0x1000, Go runtime.text at 0x1080 resolved via .rela.dyn firstmoduledata (textStart=0)
 * - authclient.ValidateAndOnboardAccount (allowedTiers BREAK_ONLY + ineligibleTiers HAS_MATCH_BODY)
 * - canary code bytes elsewhere in .text that must remain untouched
 */
function buildSyntheticLinuxCliX64Pie() {
  const buf = Buffer.alloc(0x7000, 0);

  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]).copy(buf, 0);
  buf.writeUInt16LE(3, 16); // ET_DYN (PIE)
  buf.writeUInt16LE(62, 18); // EM_X86_64
  buf.writeUInt32LE(1, 20);
  buf.writeBigUInt64LE(0x6000n, 40); // e_shoff
  buf.writeUInt16LE(64, 52);
  buf.writeUInt16LE(64, 58);
  buf.writeUInt16LE(5, 60);
  buf.writeUInt16LE(4, 62);

  const textOff = 0x1000;
  const textVA = 0x1000;
  const goTextOff = 0x1080; // PIE +0x80 offset inside .text
  const goTextVA = 0x1080;

  // fn1: canary function @ entryOff 0x040
  const canaryEntry = 0x040;
  const canaryOff = goTextOff + canaryEntry;
  Buffer.from('4883ec1031c04883c410c3', 'hex').copy(buf, canaryOff);

  // fn2: ValidateAndOnboardAccount @ entryOff 0x100
  const regEntry = 0x100;
  const regStart = goTextOff + regEntry;

  // Loop 1: allowedTiers (BREAK_ONLY)
  const alwTop = regStart + 0x20;
  buf[alwTop] = 0x48; buf[alwTop + 1] = 0xff; buf[alwTop + 2] = 0xc1;
  buf[alwTop + 3] = 0x7e; buf[alwTop + 4] = 0x29;
  const alwExit = alwTop + 0x2e;
  const alwCmp = alwTop + 0x10;
  Buffer.from('4983fa09', 'hex').copy(buf, alwCmp);
  buf[alwCmp + 4] = 0x75; buf[alwCmp + 5] = 0x18;
  Buffer.from('49ba667265652d746965', 'hex').copy(buf, alwCmp + 6);
  Buffer.from('41807b0872', 'hex').copy(buf, alwCmp + 16);
  buf[alwCmp + 21] = 0x75; buf.writeInt8(alwTop - (alwCmp + 23), alwCmp + 22);
  buf[alwCmp + 23] = 0xeb; buf.writeInt8(alwExit - (alwCmp + 25), alwCmp + 24);

  // Loop 2: ineligibleTiers (HAS_MATCH_BODY)
  const inelTop = regStart + 0x80;
  const inelExit = regStart + 0x180;
  buf[inelTop] = 0x48; buf[inelTop + 1] = 0xff; buf[inelTop + 2] = 0xc0;
  buf[inelTop + 3] = 0x0f; buf[inelTop + 4] = 0x8e; buf.writeInt32LE(inelExit - (inelTop + 9), inelTop + 5);
  const inelCmp = regStart + 0x100;
  const inelBranchOff = inelCmp + 4;
  Buffer.from('4983fb09', 'hex').copy(buf, inelCmp);
  buf[inelBranchOff] = 0x0f; buf[inelBranchOff + 1] = 0x85;
  buf.writeInt32LE(inelTop - (inelBranchOff + 6), inelBranchOff + 2);
  Buffer.from('49bb667265652d746965', 'hex').copy(buf, inelBranchOff + 6);
  Buffer.from('4d391a', 'hex').copy(buf, inelBranchOff + 16);
  buf[inelBranchOff + 19] = 0x0f; buf[inelBranchOff + 20] = 0x85;
  buf.writeInt32LE(inelTop - (inelBranchOff + 25), inelBranchOff + 21);
  Buffer.from('41807a0872', 'hex').copy(buf, inelBranchOff + 25);
  buf[inelBranchOff + 30] = 0x0f; buf[inelBranchOff + 31] = 0x85;
  buf.writeInt32LE(inelTop - (inelBranchOff + 36), inelBranchOff + 32);
  buf[inelBranchOff + 36] = 0x4d; buf[inelBranchOff + 37] = 0x85; buf[inelBranchOff + 38] = 0xe4;

  // .gopclntab at 0x2800 (textStart=0 -> exercises .rela.dyn firstmoduledata resolution)
  const pclnOff = 0x2800;
  const pclnVA = 0x2800;
  const fnNameOff = 0x100;
  const ftOff = 0x600;
  const funcs = [
    { eo: 0x000, name: 'internal/abi.(*RegArgs).Dump' },
    { eo: canaryEntry, name: 'google3/third_party/jetski/cli/model.SelectorModel.canaryFn' },
    { eo: regEntry, name: 'google3/third_party/jetski/language_server/auth_client/authclient.ValidateAndOnboardAccount' },
  ];
  Buffer.from([0xf1, 0xff, 0xff, 0xff, 0x00, 0x00, 0x01, 0x08]).copy(buf, pclnOff);
  buf.writeBigUInt64LE(BigInt(funcs.length), pclnOff + 8);
  buf.writeBigUInt64LE(0n, pclnOff + 24);
  buf.writeBigUInt64LE(BigInt(fnNameOff), pclnOff + 32);
  buf.writeBigUInt64LE(BigInt(ftOff), pclnOff + 64);

  const fnStart = pclnOff + fnNameOff;
  const ft = pclnOff + ftOff;
  const recBase = (funcs.length + 1) * 8 + 16;
  let nc = 0;
  for (let i = 0; i < funcs.length; i++) {
    const nb = Buffer.from(`${funcs[i].name}\0`, 'utf8');
    nb.copy(buf, fnStart + nc);
    const fo = recBase + i * 8;
    buf.writeUInt32LE(funcs[i].eo, ft + i * 8);
    buf.writeUInt32LE(fo, ft + i * 8 + 4);
    buf.writeUInt32LE(funcs[i].eo, ft + fo);
    buf.writeInt32LE(nc, ft + fo + 4);
    nc += nb.length;
  }
  buf.writeUInt32LE(0x980, ft + funcs.length * 8);

  // .rela.dyn at 0x4000
  const relaOff = 0x4000;
  const moddataVA = 0x9000;
  buf.writeBigUInt64LE(BigInt(moddataVA), relaOff + 0);
  buf.writeBigUInt64LE(8n, relaOff + 8);
  buf.writeBigInt64LE(BigInt(pclnVA), relaOff + 16);
  buf.writeBigUInt64LE(BigInt(moddataVA + 0xa0), relaOff + 24);
  buf.writeBigUInt64LE(8n, relaOff + 32);
  buf.writeBigInt64LE(BigInt(goTextVA), relaOff + 40);
  buf.writeBigUInt64LE(BigInt(moddataVA + 0xb0), relaOff + 48);
  buf.writeBigUInt64LE(8n, relaOff + 56);
  buf.writeBigInt64LE(BigInt(goTextVA), relaOff + 64);

  const shstrOff = 0x5000;
  const shstr = '\0.text\0.lrodata\0.rela.dyn\0.shstrtab\0';
  buf.write(shstr, shstrOff, 'ascii');

  writeElfSectionHeader(buf, 0x6000 + 0 * 64, { nameOff: 0, type: 0, flags: 0, addr: 0, fileOff: 0, size: 0 });
  writeElfSectionHeader(buf, 0x6000 + 1 * 64, { nameOff: 1, type: 1, flags: 6, addr: textVA, fileOff: textOff, size: 0x1000 });
  writeElfSectionHeader(buf, 0x6000 + 2 * 64, { nameOff: 7, type: 1, flags: 2, addr: pclnVA, fileOff: pclnOff, size: 0x1000 });
  writeElfSectionHeader(buf, 0x6000 + 3 * 64, { nameOff: 16, type: 4, flags: 2, addr: relaOff, fileOff: relaOff, size: 72, entsize: 24 });
  writeElfSectionHeader(buf, 0x6000 + 4 * 64, { nameOff: 26, type: 3, flags: 0, addr: 0, fileOff: shstrOff, size: shstr.length });

  return { buf, canaryOff, regStart, alwCmp, inelBranchOff };
}

/**
 * Build a synthetic Linux ELF64 arm64 agy CLI binary with ValidateAndOnboardAccount.
 */
function buildSyntheticLinuxCliArm64() {
  const buf = Buffer.alloc(0x8000, 0);

  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]).copy(buf, 0);
  buf.writeUInt16LE(2, 16); // ET_EXEC
  buf.writeUInt16LE(183, 18); // EM_AARCH64
  buf.writeUInt32LE(1, 20);
  buf.writeBigUInt64LE(0x7000n, 40);
  buf.writeUInt16LE(64, 52);
  buf.writeUInt16LE(64, 58);
  buf.writeUInt16LE(4, 60);
  buf.writeUInt16LE(3, 62);

  const textOff = 0x1000;
  const textVA = 0x400000;

  const encBCond = (cond, from, to) => {
    const imm19 = ((to - from) / 4) & 0x7ffff;
    return (0x54000000 | (imm19 << 5) | (cond & 0xf)) >>> 0;
  };

  // fn1: canary @ 0x040
  const canaryEntry = 0x040;
  const canaryOff = textOff + canaryEntry;
  buf.writeUInt32LE(0xf9400b90, canaryOff);
  buf.writeUInt32LE(0xd65f03c0, canaryOff + 4);

  // fn2: ValidateAndOnboardAccount @ 0x100
  const regEntry = 0x100;
  const regStart = textOff + regEntry;
  const alwT = regStart + 0x20;
  const alwP = regStart + 0x30;
  const alwTailEnd = alwP + 0x18;
  buf.writeUInt32LE(encBCond(0xd, alwT + 4, alwTailEnd), alwT + 4);
  buf.writeUInt32LE(0xf100251f, alwP);
  buf.writeUInt32LE(encBCond(1, alwP + 4, alwT), alwP + 4);
  buf.writeUInt32LE(0x528e4cc9, alwP + 8);
  buf.writeUInt32LE(encBCond(1, alwP + 12, alwT), alwP + 12);
  buf.writeUInt32LE(0x7101c91f, alwP + 16);
  buf.writeUInt32LE(encBCond(1, alwP + 20, alwT), alwP + 20);

  const inelT = regStart + 0x80;
  const inelP = regStart + 0x90;
  const inelTailEnd = inelP + 0x18;
  const inelExit = inelTailEnd + 0x40;
  buf.writeUInt32LE(encBCond(0xd, inelT + 4, inelExit), inelT + 4);
  buf.writeUInt32LE(0xf100251f, inelP);
  const inelBranchOff = inelP + 4;
  buf.writeUInt32LE(encBCond(1, inelBranchOff, inelT), inelBranchOff);
  buf.writeUInt32LE(0x528e4cc9, inelP + 8);
  buf.writeUInt32LE(encBCond(1, inelP + 12, inelT), inelP + 12);
  buf.writeUInt32LE(0x7101c91f, inelP + 16);
  buf.writeUInt32LE(encBCond(1, inelP + 20, inelT), inelP + 20);

  // .gopclntab at 0x2800
  const pclnOff = 0x2800;
  const fnNameOff = 0x100;
  const ftOff = 0x700;
  const funcs = [
    { eo: 0x000, name: 'internal/abi.(*RegArgs).Dump' },
    { eo: canaryEntry, name: 'exa.google/cli/model.SelectorModel.canaryFn' },
    { eo: regEntry, name: 'exa.google/authclient.ValidateAndOnboardAccount' },
  ];
  Buffer.from([0xf1, 0xff, 0xff, 0xff, 0x00, 0x00, 0x04, 0x08]).copy(buf, pclnOff);
  buf.writeBigUInt64LE(BigInt(funcs.length), pclnOff + 8);
  buf.writeBigUInt64LE(BigInt(textVA), pclnOff + 24);
  buf.writeBigUInt64LE(BigInt(fnNameOff), pclnOff + 32);
  buf.writeBigUInt64LE(BigInt(ftOff), pclnOff + 64);

  const fnStart = pclnOff + fnNameOff;
  const ft = pclnOff + ftOff;
  const recBase = (funcs.length + 1) * 8 + 16;
  let nc = 0;
  for (let i = 0; i < funcs.length; i++) {
    const nb = Buffer.from(`${funcs[i].name}\0`, 'utf8');
    nb.copy(buf, fnStart + nc);
    const fo = recBase + i * 8;
    buf.writeUInt32LE(funcs[i].eo, ft + i * 8);
    buf.writeUInt32LE(fo, ft + i * 8 + 4);
    buf.writeUInt32LE(funcs[i].eo, ft + fo);
    buf.writeInt32LE(nc, ft + fo + 4);
    nc += nb.length;
  }
  buf.writeUInt32LE(0x880, ft + funcs.length * 8);

  const shstrOff = 0x6000;
  const shstr = '\0.text\0.gopclntab\0.shstrtab\0';
  buf.write(shstr, shstrOff, 'ascii');
  writeElfSectionHeader(buf, 0x7000 + 0 * 64, { nameOff: 0, type: 0, flags: 0, addr: 0, fileOff: 0, size: 0 });
  writeElfSectionHeader(buf, 0x7000 + 1 * 64, { nameOff: 1, type: 1, flags: 6, addr: textVA, fileOff: textOff, size: 0x1000 });
  writeElfSectionHeader(buf, 0x7000 + 2 * 64, { nameOff: 7, type: 1, flags: 2, addr: 0x500000, fileOff: pclnOff, size: 0x1000 });
  writeElfSectionHeader(buf, 0x7000 + 3 * 64, { nameOff: 18, type: 3, flags: 0, addr: 0, fileOff: shstrOff, size: shstr.length });

  return { buf, canaryOff, alwP, inelBranchOff };
}

test('meter-cli-unlock detects & patches Linux ELF64 x86-64 PIE agy CLI region unlock cleanly', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-cli-x64-'));
  try {
    const homeDir = path.join(tmp, 'home');
    const stateDir = path.join(tmp, 'state');
    const backupDir = path.join(tmp, 'backups');
    const cliBin = path.join(homeDir, '.local', 'bin', 'agy');
    fs.mkdirSync(path.dirname(cliBin), { recursive: true });

    const fx = buildSyntheticLinuxCliX64Pie();
    const origAllowed = Buffer.from(fx.buf.subarray(fx.alwCmp, fx.alwCmp + 25));
    const origCanary = Buffer.from(fx.buf.subarray(fx.canaryOff, fx.canaryOff + 11));
    fs.writeFileSync(cliBin, fx.buf, { mode: 0o755 });

    // Auto-detect via homeDir (~/.local/bin/agy)
    const pre = cli.analyzeAgyCli(null, { homeDir, stateDir, backupDir });
    assert.equal(pre.ok, true);
    assert.equal(pre.found, true);
    assert.equal(pre.format, 'ELF64');
    assert.equal(pre.arch, 'x86-64');
    assert.equal(pre.goTextSource, 'rela_firstmoduledata');
    assert.equal(pre.status, 'unpatched');
    assert.equal(pre.regionUnlock.status, 'unpatched');

    const res = cli.applyAgyCliUnlock({
      homeDir,
      stateDir,
      backupDir,
      skipCodesign: true,
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.changed, true);
    assert.equal(res.format, 'ELF64');
    assert.equal(res.arch, 'x86-64');
    assert.deepEqual(res.patchedHooks, ['ValidateAndOnboardAccount']);
    assert.equal(res.analysis.status, 'patched');

    const disk = fs.readFileSync(cliBin);
    assert.equal(disk[fx.inelBranchOff], 0x90);
    assert.equal(disk[fx.inelBranchOff + 1], 0xe9);
    assert.deepEqual(disk.subarray(fx.alwCmp, fx.alwCmp + 25), origAllowed);
    assert.deepEqual(disk.subarray(fx.canaryOff, fx.canaryOff + 11), origCanary);
    assert.equal(fs.existsSync(path.join(homeDir, '.gemini', 'config', 'config.json')), false);

    // Idempotent re-apply
    const resAgain = cli.applyAgyCliUnlock({
      homeDir,
      stateDir,
      backupDir,
      skipCodesign: true,
    });
    assert.equal(resAgain.ok, true);
    assert.equal(resAgain.changed, false);
    assert.equal(resAgain.alreadyPatched, true);

    // Fail-closed when ValidateAndOnboardAccount exists but pattern is unrecognised
    const brokenBin = path.join(tmp, 'agy-broken-region');
    const brokenBuf = Buffer.from(fx.buf);
    brokenBuf.fill(0, fx.regStart, fx.regStart + 0x200);
    fs.writeFileSync(brokenBin, brokenBuf, { mode: 0o755 });
    const brokenRes = cli.applyAgyCliUnlock({
      binaryPath: brokenBin,
      homeDir: path.join(tmp, 'broken-home'),
      stateDir,
      backupDir,
      skipBackup: true,
      skipCodesign: true,
    });
    assert.equal(brokenRes.ok, false);
    assert.equal(brokenRes.code, 'PATTERN_NOT_FOUND');
    assert.deepEqual(fs.readFileSync(brokenBin), brokenBuf);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('meter-cli-unlock patches Linux ELF64 arm64 agy CLI region unlock cleanly', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-cli-a64-'));
  try {
    const homeDir = path.join(tmp, 'home');
    const stateDir = path.join(tmp, 'state');
    const backupDir = path.join(tmp, 'backups');
    const cliBin = path.join(homeDir, '.local', 'bin', 'agy');
    fs.mkdirSync(path.dirname(cliBin), { recursive: true });

    const fx = buildSyntheticLinuxCliArm64();
    const origAllowedWord = fx.buf.readUInt32LE(fx.alwP + 4);
    const origCanary = Buffer.from(fx.buf.subarray(fx.canaryOff, fx.canaryOff + 8));
    fs.writeFileSync(cliBin, fx.buf, { mode: 0o755 });

    const res = cli.applyAgyCliUnlock({
      binaryPath: cliBin,
      homeDir,
      stateDir,
      backupDir,
      skipCodesign: true,
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.changed, true);
    assert.deepEqual(res.patchedHooks, ['ValidateAndOnboardAccount']);
    assert.equal(res.analysis.format, 'ELF64');
    assert.equal(res.analysis.arch, 'arm64');
    assert.equal(res.analysis.status, 'patched');

    const disk = fs.readFileSync(cliBin);
    assert.equal(disk.readUInt32LE(fx.alwP + 4), origAllowedWord);
    assert.equal(((disk.readUInt32LE(fx.inelBranchOff) & 0xfc000000) >>> 0), 0x14000000);
    assert.deepEqual(disk.subarray(fx.canaryOff, fx.canaryOff + 8), origCanary);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('unlock/agy-cli/agy-patch.py matches Node ELF64 CLI region unlock on both x86-64 PIE and arm64', (t) => {
  const pyCheck = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (pyCheck.status !== 0) {
    t.skip('python3 not available in test environment');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-agy-py-'));
  try {
    const pyScript = path.join(ROOT, 'unlock', 'agy-cli', 'agy-patch.py');
    for (const [label, fx] of [
      ['x64', buildSyntheticLinuxCliX64Pie()],
      ['arm64', buildSyntheticLinuxCliArm64()],
    ]) {
      const binPath = path.join(tmp, `agy_${label}`);
      fs.writeFileSync(binPath, fx.buf, { mode: 0o755 });

      const rPatch = spawnSync(
        'python3',
        [pyScript, '--binary', binPath, '--in-place'],
        { encoding: 'utf8' }
      );
      assert.equal(rPatch.status, 0, `agy-patch.py ${label} failed: ${rPatch.stderr}\n${rPatch.stdout}`);

      const analyzed = cli.analyzeAgyCli(binPath, { homeDir: path.join(tmp, `home_${label}`), stateDir: tmp });
      assert.equal(analyzed.status, 'patched');
      assert.equal(analyzed.regionUnlock.status, 'patched');

      const rAgain = spawnSync(
        'python3',
        [pyScript, '--binary', binPath, '--in-place'],
        { encoding: 'utf8' }
      );
      assert.equal(rAgain.status, 0, `agy-patch.py ${label} idempotent re-run failed: ${rAgain.stderr}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('build-hakimi.sh --cli-only patches Linux ELF64 agy CLI without requiring macOS desktop bundle or codesign', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-sh-cli-'));
  try {
    const homeDir = path.join(tmp, 'home');
    const stateDir = path.join(tmp, 'state');
    const cliBin = path.join(homeDir, '.local', 'bin', 'agy');
    fs.mkdirSync(path.dirname(cliBin), { recursive: true });
    const fx = buildSyntheticLinuxCliX64Pie();
    fs.writeFileSync(cliBin, fx.buf, { mode: 0o755 });

    const res = spawnSync(
      'bash',
      [path.join(ROOT, 'build-hakimi.sh'), '--cli-only', '--cli-bin', cliBin],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: homeDir,
          HAKIMI_STATE_DIR: stateDir,
        },
      }
    );
    assert.equal(res.status, 0, `build-hakimi.sh --cli-only failed: ${res.stderr}\n${res.stdout}`);
    const after = cli.analyzeAgyCli(cliBin, { homeDir, stateDir });
    assert.equal(after.status, 'patched');
    assert.equal(after.regionUnlock.status, 'patched');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
