'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const enhance = require(path.join(ROOT, 'payload', 'dist', 'meter-enhance.js'));
const regionUnlock = require(path.join(ROOT, 'payload', 'dist', 'meter-region-unlock.js'));
const cliUnlock = require(path.join(ROOT, 'payload', 'dist', 'meter-cli-unlock.js'));

function writeSyntheticGopclntab(buf, pclnBase, textVA, functions, sentinelEndOff = 0x920) {
  const fnOff = 0x100;
  const pclnOff = 0x400;

  Buffer.from([0xf1, 0xff, 0xff, 0xff, 0x00, 0x00, 0x04, 0x08]).copy(buf, pclnBase);
  buf.writeBigUInt64LE(BigInt(functions.length), pclnBase + 8);
  buf.writeBigUInt64LE(textVA, pclnBase + 24);
  buf.writeBigUInt64LE(BigInt(fnOff), pclnBase + 32);
  buf.writeBigUInt64LE(BigInt(pclnOff), pclnBase + 64);

  const fnstart = pclnBase + fnOff;
  const pcln = pclnBase + pclnOff;
  const recBaseRelToPcln = (functions.length + 1) * 8 + 16;

  let nameCursor = 0;
  for (let i = 0; i < functions.length; i++) {
    const fn = functions[i];
    const nameBytes = Buffer.from(`${fn.name}\0`, 'ascii');
    nameBytes.copy(buf, fnstart + nameCursor);

    const funcoff = recBaseRelToPcln + i * 8;
    buf.writeUInt32LE(fn.entryoff, pcln + i * 8);
    buf.writeUInt32LE(funcoff, pcln + i * 8 + 4);
    buf.writeUInt32LE(fn.entryoff, pcln + funcoff);
    buf.writeInt32LE(nameCursor, pcln + funcoff + 4);

    nameCursor += nameBytes.length;
  }
  buf.writeUInt32LE(sentinelEndOff, pcln + functions.length * 8);
}

function initSyntheticMachOHeader(buf, textVA = 0x100000000n, textSize = 0x1000n, textOff = 0x1000) {
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(0x0100000c, 4);
  buf.writeUInt32LE(2, 12);
  buf.writeUInt32LE(2, 16);
  buf.writeUInt32LE(24 + 152, 20);

  buf.writeUInt32LE(0x1b, 32);
  buf.writeUInt32LE(24, 36);
  Buffer.from('aabbccddeeff00112233445566778899', 'hex').copy(buf, 40);

  buf.writeUInt32LE(0x19, 56);
  buf.writeUInt32LE(152, 60);
  buf.write('__TEXT\0', 64, 'ascii');
  buf.writeUInt32LE(1, 56 + 64);

  const sectOff = 56 + 72;
  buf.write('__text\0', sectOff, 'ascii');
  buf.write('__TEXT\0', sectOff + 16, 'ascii');
  buf.writeBigUInt64LE(textVA, sectOff + 32);
  buf.writeBigUInt64LE(textSize, sectOff + 40);
  buf.writeUInt32LE(textOff, sectOff + 48);
}

function encodeArm64BCond(cond, fromOff, toOff) {
  const imm19 = (toOff - fromOff) / 4;
  return (0x54000000 | ((imm19 & 0x7ffff) << 5) | (cond & 0x0f)) >>> 0;
}

function buildSyntheticArm64RegionFixture() {
  const buf = Buffer.alloc(0x4000, 0);
  const textOff = 0x1000;
  initSyntheticMachOHeader(buf, 0x100000000n, 0x1000n, textOff);

  writeSyntheticGopclntab(
    buf,
    0x2000,
    0x100000000n,
    [
      { entryoff: 0x000, name: 'internal/abi.(*RegArgs).Dump' },
      { entryoff: 0x100, name: 'exa.google/internal/authclient.ValidateAndOnboardAccount' },
      { entryoff: 0x400, name: 'exa.google/internal/pkg.afterFn' },
    ],
    0x500
  );

  const fnStart = textOff + 0x100;
  buf.writeUInt32LE(0x528e4cc9, fnStart + 0x04); // movz w9, #0x7266 ("fr" / "free-tie" hint)

  // Loop 1 (allowedTiers - BREAK_ONLY): loop exit jumps strictly == tailEnd1
  const T1 = fnStart + 0x20;
  const p1 = T1 + 0x0c;
  const tailEnd1 = p1 + 0x14;
  buf.writeUInt32LE(encodeArm64BCond(0x0a, T1, tailEnd1), T1); // b.ge tailEnd1
  buf.writeUInt32LE(0xf100251f, p1); // cmp x8, #9
  buf.writeUInt32LE(encodeArm64BCond(0x01, p1 + 4, T1), p1 + 4); // b.ne T1
  buf.writeUInt32LE(encodeArm64BCond(0x01, p1 + 8, T1), p1 + 8); // inter b.ne T1
  buf.writeUInt32LE(0x7101c95f, p1 + 0x0c); // cmp w10, #0x72 ('r')
  buf.writeUInt32LE(encodeArm64BCond(0x01, p1 + 0x10, T1), p1 + 0x10); // stage-3 b.ne T1

  // Loop 2 (ineligibleTiers - HAS_MATCH_BODY): loop exit jumps strictly > tailEnd2
  const T2 = fnStart + 0xc0;
  const p2 = T2 + 0x0c;
  const tailEnd2 = p2 + 0x14;
  buf.writeUInt32LE(encodeArm64BCond(0x0a, T2, tailEnd2 + 0x20), T2); // b.ge past match body
  buf.writeUInt32LE(0xf100251f, p2); // cmp x8, #9
  buf.writeUInt32LE(encodeArm64BCond(0x01, p2 + 4, T2), p2 + 4); // b.ne T2
  buf.writeUInt32LE(encodeArm64BCond(0x01, p2 + 8, T2), p2 + 8); // inter b.ne T2
  buf.writeUInt32LE(0x7101c95f, p2 + 0x0c); // cmp w10, #0x72 ('r')
  buf.writeUInt32LE(encodeArm64BCond(0x01, p2 + 0x10, T2), p2 + 0x10); // stage-3 b.ne T2

  return { buf, fnStart, p1, p2 };
}

test('meter-region-unlock dynamically locates ineligibleTiers free-tier check while leaving allowedTiers loop and missing logic safe', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-region-test-'));
  try {
    const { buf, fnStart, p1, p2 } = buildSyntheticArm64RegionFixture();
    const targetBin = path.join(tmp, 'FakeHakimi.app', 'Contents', 'Resources', 'bin', 'language_server');
    fs.mkdirSync(path.dirname(targetBin), { recursive: true });
    fs.writeFileSync(targetBin, buf);

    const pre = regionUnlock.analyzeRegionUnlock(targetBin);
    assert.equal(pre.ok, true);
    assert.equal(pre.status, 'unpatched');
    assert.equal(pre.allowedTiersCount, 1);
    assert.equal(pre.branchOffset, p2 + 4);
    const loop1Before = buf.readUInt32LE(p1 + 4);

    const applied = regionUnlock.applyRegionUnlock(targetBin);
    assert.equal(applied.ok, true);
    assert.equal(applied.status, 'patched');
    assert.equal(applied.alreadyPatched, false);

    const diskBuf = fs.readFileSync(targetBin);
    assert.equal(diskBuf.readUInt32LE(p1 + 4), loop1Before, 'Loop 1 (allowedTiers) must stay untouched');
    assert.equal((diskBuf.readUInt32LE(p2 + 4) & 0xfc000000) >>> 0, 0x14000000, 'Loop 2 must become unconditional b');

    const post = regionUnlock.analyzeRegionUnlock(targetBin);
    assert.equal(post.ok, true);
    assert.equal(post.status, 'patched');

    const idempotent = regionUnlock.applyRegionUnlock(targetBin);
    assert.equal(idempotent.ok, true);
    assert.equal(idempotent.alreadyPatched, true);

    assert.throws(
      () => regionUnlock.applyRegionUnlock('/Applications/Antigravity.app/Contents/Resources/bin/language_server'),
      /Refusing to apply region unlock official Antigravity\.app/
    );

    const removedBuf = Buffer.from(buf);
    removedBuf.fill(0, fnStart, fnStart + 0x200);
    removedBuf.writeUInt32LE(0xd65f03c0, fnStart); // ret
    const missingPatternRes = regionUnlock.analyzeRegionUnlock(removedBuf);
    assert.equal(missingPatternRes.ok, false);
    assert.equal(missingPatternRes.code, 'PATTERN_NOT_FOUND');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('meter-cli-unlock applies Mach-O ARM64 region unlock, detects broken symlinks, and blocks official app', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-cli-test-'));
  try {
    const homeDir = path.join(tmp, 'home');
    const stateDir = path.join(tmp, 'state');
    const backupDir = path.join(tmp, 'backups');
    fs.mkdirSync(homeDir, { recursive: true });

    const { buf, p1, p2 } = buildSyntheticArm64RegionFixture();
    const loop1Before = buf.readUInt32LE(p1 + 4);
    const cliBin = path.join(homeDir, '.local', 'bin', 'agy');
    fs.mkdirSync(path.dirname(cliBin), { recursive: true });
    fs.writeFileSync(cliBin, buf);
    fs.chmodSync(cliBin, 0o755);

    const pre = cliUnlock.analyzeAgyCli(cliBin, { homeDir, stateDir });
    assert.equal(pre.ok, true);
    assert.equal(pre.found, true);
    assert.equal(pre.status, 'unpatched');
    assert.equal(pre.regionUnlock.status, 'unpatched');

    const res = cliUnlock.applyAgyCliUnlock({
      binaryPath: cliBin,
      homeDir,
      stateDir,
      backupDir,
      skipCodesign: true,
    });
    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.deepEqual(res.patchedHooks, ['ValidateAndOnboardAccount']);

    const post = cliUnlock.analyzeAgyCli(cliBin, { homeDir, stateDir });
    assert.equal(post.status, 'patched');
    assert.equal(post.regionUnlock.status, 'patched');
    const diskBuf = fs.readFileSync(cliBin);
    assert.equal(diskBuf.readUInt32LE(p1 + 4), loop1Before);
    assert.equal((diskBuf.readUInt32LE(p2 + 4) & 0xfc000000) >>> 0, 0x14000000);
    assert.equal(fs.existsSync(path.join(homeDir, '.gemini', 'config', 'config.json')), false);

    const second = cliUnlock.applyAgyCliUnlock({
      binaryPath: cliBin,
      homeDir,
      stateDir,
      backupDir,
      skipCodesign: true,
    });
    assert.equal(second.ok, true);
    assert.equal(second.changed, false);
    assert.equal(second.alreadyPatched, true);

    // Broken symlink detection on clean home without binary
    const brokenHome = path.join(tmp, 'broken-home');
    const brokenLink = path.join(brokenHome, '.antigravity', 'antigravity', 'bin', 'agy');
    fs.mkdirSync(path.dirname(brokenLink), { recursive: true });
    fs.symlinkSync('/nonexistent/agy', brokenLink);
    const brokenRes = cliUnlock.analyzeAgyCli(null, { homeDir: brokenHome, stateDir });
    assert.equal(brokenRes.found, false);
    assert.equal(brokenRes.status, 'not_found');
    assert.equal(brokenRes.brokenSymlinks.length, 1);

    const officialCli = cliUnlock.applyAgyCliUnlock({
      binaryPath: '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
      skipCodesign: true,
    });
    assert.equal(officialCli.ok, false);
    assert.equal(officialCli.code, 'OFFICIAL_APP_FORBIDDEN');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('meter-enhance resolveTargetBinaries rejects official Antigravity.app and enforces isolation guards', () => {
  const officialLs = '/Applications/Antigravity.app/Contents/Resources/bin/language_server';

  assert.throws(
    () => enhance.resolveTargetBinaries({ targets: [{ id: 'desktop', path: officialLs }] }),
    /Refusing to target language_server binary official Antigravity\.app/
  );
  assert.throws(
    () => enhance.resolveTargetBinaries({ appPath: '/Applications/Antigravity.app' }),
    /Refusing to target app bundle official Antigravity\.app/
  );
  const resolved = enhance.resolveTargetBinaries({
    targets: [{ id: 'desktop', path: '/Applications/哈基米.app/Contents/Resources/bin/language_server' }],
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, 'desktop');
});
