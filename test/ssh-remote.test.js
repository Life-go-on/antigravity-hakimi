'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const sshMod = require(path.join(ROOT, 'payload', 'dist', 'meter-ssh.js'));
const modularInstaller = require(path.join(ROOT, 'payload', 'dist', 'modular-installer.js'));
const asarEngine = require(path.join(ROOT, 'payload', 'dist', 'asar-engine.js'));
const modulesConfig = require(path.join(ROOT, 'payload', 'dist', 'modules-config.js'));
const collector = require(path.join(ROOT, 'payload', 'dist', 'meter-collector.js'));
const { packHakimiAsar } = require(path.join(ROOT, 'scripts', 'pack-hakimi-asar.js'));

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
 * Build a synthetic PIE Linux ELF64 x86-64 binary with:
 * - .text at 0x1000 (Go runtime.text at 0x1080 via .rela.dyn firstmoduledata)
 * - .lrodata (.gopclntab with textStart=0 to exercise PIE relocation path)
 * - .rela.dyn with firstmoduledata.pcHeader -> pclnVA and minpc/text -> 0x1080
 * - ValidateAndOnboardAccount (both allowedTiers BREAK_ONLY + ineligibleTiers HAS_MATCH_BODY)
 */
function buildSyntheticElf64X64Pie() {
  const buf = Buffer.alloc(0x6000, 0);

  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]).copy(buf, 0);
  buf.writeUInt16LE(3, 16); // ET_DYN (PIE)
  buf.writeUInt16LE(62, 18); // EM_X86_64
  buf.writeUInt32LE(1, 20);
  buf.writeBigUInt64LE(0x5000n, 40); // e_shoff
  buf.writeUInt16LE(64, 52); // e_ehsize
  buf.writeUInt16LE(64, 58); // e_shentsize
  buf.writeUInt16LE(5, 60); // e_shnum
  buf.writeUInt16LE(4, 62); // e_shstrndx

  const textOff = 0x1000;
  const textVA = 0x1000;
  const goTextOff = 0x1080; // +0x80 offset inside .text
  const goTextVA = 0x1080;

  // fn1: authclient.ValidateAndOnboardAccount @ entryOff 0x100
  const regEntry = 0x100;
  const regStart = goTextOff + regEntry;

  // Loop 1: allowedTiers (BREAK_ONLY) at regStart + 0x20
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

  // Loop 2: ineligibleTiers (HAS_MATCH_BODY) at regStart + 0x80
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

  // .lrodata with .gopclntab at 0x2800 (textStart=0 -> forces PIE .rela.dyn lookup)
  const pclnOff = 0x2800;
  const pclnVA = 0x2800;
  const fnNameOff = 0x100;
  const ftOff = 0x500;
  const funcs = [
    { eo: 0x000, name: 'internal/abi.(*RegArgs).Dump' },
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

  // .rela.dyn at 0x3800
  const relaOff = 0x3800;
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

  const shstrOff = 0x4800;
  const shstr = '\0.text\0.lrodata\0.rela.dyn\0.shstrtab\0';
  buf.write(shstr, shstrOff, 'ascii');

  writeElfSectionHeader(buf, 0x5000 + 0 * 64, { nameOff: 0, type: 0, flags: 0, addr: 0, fileOff: 0, size: 0 });
  writeElfSectionHeader(buf, 0x5000 + 1 * 64, { nameOff: 1, type: 1, flags: 6, addr: textVA, fileOff: textOff, size: 0x1000 });
  writeElfSectionHeader(buf, 0x5000 + 2 * 64, { nameOff: 7, type: 1, flags: 2, addr: pclnVA, fileOff: pclnOff, size: 0x1000 });
  writeElfSectionHeader(buf, 0x5000 + 3 * 64, { nameOff: 16, type: 4, flags: 2, addr: relaOff, fileOff: relaOff, size: 72, entsize: 24 });
  writeElfSectionHeader(buf, 0x5000 + 4 * 64, { nameOff: 26, type: 3, flags: 0, addr: 0, fileOff: shstrOff, size: shstr.length });

  return { buf, alwCmp, inelBranchOff };
}

function buildSyntheticElf64Arm64() {
  const buf = Buffer.alloc(0x6000, 0);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]).copy(buf, 0);
  buf.writeUInt16LE(2, 16); // ET_EXEC
  buf.writeUInt16LE(183, 18); // EM_AARCH64
  buf.writeUInt32LE(1, 20);
  buf.writeBigUInt64LE(0x5000n, 40);
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

  // fn1: ValidateAndOnboardAccount @ entryOff 0x100
  const regEntry = 0x100;
  const regStart = textOff + regEntry;

  // Loop 1: allowedTiers (BREAK_ONLY)
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

  // Loop 2: ineligibleTiers (HAS_MATCH_BODY)
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

  // .gopclntab at 0x2800 (minLC=4, textStart=textVA)
  const pclnOff = 0x2800;
  const fnNameOff = 0x100;
  const ftOff = 0x500;
  const funcs = [
    { eo: 0x000, name: 'internal/abi.(*RegArgs).Dump' },
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

  const shstrOff = 0x4800;
  const shstr = '\0.text\0.gopclntab\0.shstrtab\0';
  buf.write(shstr, shstrOff, 'ascii');
  writeElfSectionHeader(buf, 0x5000 + 0 * 64, { nameOff: 0, type: 0, flags: 0, addr: 0, fileOff: 0, size: 0 });
  writeElfSectionHeader(buf, 0x5000 + 1 * 64, { nameOff: 1, type: 1, flags: 6, addr: textVA, fileOff: textOff, size: 0x1000 });
  writeElfSectionHeader(buf, 0x5000 + 2 * 64, { nameOff: 7, type: 1, flags: 2, addr: 0x500000, fileOff: pclnOff, size: 0x1000 });
  writeElfSectionHeader(buf, 0x5000 + 3 * 64, { nameOff: 18, type: 3, flags: 0, addr: 0, fileOff: shstrOff, size: shstr.length });

  return { buf, alwP, inelBranchOff };
}

test('ELF64 x86-64 PIE adaptive region unlock patches cleanly and preserves allowedTiers', () => {
  const { buf, alwCmp, inelBranchOff } = buildSyntheticElf64X64Pie();
  const origAllowedBytes = Buffer.from(buf.subarray(alwCmp, alwCmp + 25));

  const reg0 = sshMod.analyzeElfRegionUnlock(buf);
  assert.equal(reg0.ok, true);
  assert.equal(reg0.arch, 'x86-64');
  assert.equal(reg0.goTextSource, 'rela_firstmoduledata');
  assert.equal(reg0.status, 'unpatched');
  assert.equal(reg0.branchOffset, inelBranchOff);
  assert.equal(reg0.allowedTiersCount, 1);

  const patched = sshMod.patchElfBuffer(buf);
  assert.equal(patched.ok, true);
  assert.equal(patched.modified, true);
  assert.equal(patched.buffer[inelBranchOff], 0x90);
  assert.equal(patched.buffer[inelBranchOff + 1], 0xe9);
  assert.deepEqual(patched.buffer.subarray(alwCmp, alwCmp + 25), origAllowedBytes);

  const reg1 = sshMod.analyzeElfRegionUnlock(patched.buffer);
  assert.equal(reg1.ok, true);
  assert.equal(reg1.status, 'patched');

  const again = sshMod.patchElfBuffer(patched.buffer);
  assert.equal(again.ok, true);
  assert.equal(again.modified, false);
});

test('ELF64 arm64 adaptive region unlock patches cleanly and preserves allowedTiers', () => {
  const { buf, alwP, inelBranchOff } = buildSyntheticElf64Arm64();
  const origAllowedWord = buf.readUInt32LE(alwP + 4);

  const patched = sshMod.patchElfBuffer(buf);
  assert.equal(patched.ok, true);
  assert.equal(patched.modified, true);
  assert.equal(patched.buffer.readUInt32LE(alwP + 4), origAllowedWord);
  assert.equal(((patched.buffer.readUInt32LE(inelBranchOff) & 0xfc000000) >>> 0), 0x14000000);
  assert.equal(sshMod.analyzeElfRegionUnlock(patched.buffer).status, 'patched');

  const again = sshMod.patchElfBuffer(patched.buffer);
  assert.equal(again.ok, true);
  assert.equal(again.modified, false);
});

test('embedded Python3 remote patcher matches Node ELF64 region engine on both x86-64 PIE and arm64', (t) => {
  const pyCheck = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (pyCheck.status !== 0) {
    t.skip('python3 not available in test environment');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-ssh-py-'));
  try {
    const pyPath = path.join(tmp, 'patcher.py');
    fs.writeFileSync(pyPath, sshMod.getRemotePythonPatcherSource(), 'utf8');

    for (const [label, fixture] of [
      ['x64', buildSyntheticElf64X64Pie()],
      ['arm64', buildSyntheticElf64Arm64()],
    ]) {
      const binPath = path.join(tmp, `ls_${label}`);
      fs.writeFileSync(binPath, fixture.buf);

      // 1. Analyze only
      const r0 = spawnSync('python3', [pyPath, '--analyze', binPath], { encoding: 'utf8' });
      assert.equal(r0.status, 0, `${label} analyze failed: ${r0.stderr}`);
      const j0 = JSON.parse(r0.stdout);
      assert.equal(j0.ok, true);
      assert.equal(j0.region.status, 'unpatched');

      // 2. Patch region unlock
      const r1 = spawnSync('python3', [pyPath, binPath], { encoding: 'utf8' });
      assert.equal(r1.status, 0, `${label} region patch failed: ${r1.stderr}`);
      const j1 = JSON.parse(r1.stdout);
      assert.equal(j1.ok, true);
      assert.equal(j1.changed, true);

      // 3. Re-verify with Node analyzer
      const patchedBuf = fs.readFileSync(binPath);
      assert.equal(sshMod.analyzeElfRegionUnlock(patchedBuf).status, 'patched');

      // 4. Idempotent re-run
      const r2 = spawnSync('python3', [pyPath, binPath], { encoding: 'utf8' });
      assert.equal(r2.status, 0, `${label} idempotent run failed: ${r2.stderr}`);
      const j2 = JSON.parse(r2.stdout);
      assert.equal(j2.ok, true);
      assert.equal(j2.changed, false);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('decorateBootstrapScript produces valid POSIX sh syntax and packHakimiAsar injects SSH hooks cleanly', () => {
  const sampleScript = [
    '#!/bin/sh',
    'agy_main() { agy_run; }',
    'agy_run() { agy_check_paths; agy_prepare; }',
    'agy_check_paths() { :; }',
    'agy_prepare() { :; }',
    'agy_main; exit $?',
    '',
  ].join('\n');

  const decorated = sshMod.decorateBootstrapScript(sampleScript);
  assert.ok(decorated.includes('hakimi_patch_bin()'));
  assert.ok(decorated.includes('hakimi_maybe_replace_unpatched()'));
  assert.ok(decorated.indexOf('hakimi_patch_bin()') < decorated.lastIndexOf('agy_main; exit $?'));
  // Idempotent
  assert.equal(sshMod.decorateBootstrapScript(decorated), decorated);

  // Verify POSIX /bin/sh -n syntax check
  const shCheck = spawnSync('/bin/sh', ['-n'], { input: decorated, encoding: 'utf8' });
  assert.equal(shCheck.status, 0, `POSIX sh -n failed: ${shCheck.stderr}`);

  // Verify ASAR packing with dist/remote/* files and round-trip cleaning
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-ssh-asar-'));
  try {
    const srcDir = path.join(tmp, 'src');
    fs.mkdirSync(path.join(srcDir, 'dist', 'remote'), { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'dist', 'utils.js'),
      [
        'function setupNodeWrapper(env) { return env; }',
        'function createWindow(url, storageManager) {',
        '    const win = { loadURL() {} };',
        '    void win.loadURL(url);',
        '    return win;',
        '}',
        'function showOrCreateWindow(port) {',
        '    const wins = [];',
        '    if (wins.length) {',
        '        wins[0].focus();',
        '        return;',
        '    }',
        '        createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);',
        '}',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(path.join(srcDir, 'dist', 'preload.js'), 'const electron_1 = {};\n', 'utf8');
    fs.writeFileSync(
      path.join(srcDir, 'dist', 'remote', 'bootstrapScript.js'),
      'const SCRIPT_BODY = "\\nagy_main; exit $?\\n";\nfunction buildBootstrapScript() {\n    const header = "#!/bin/sh\\n";\n    return header + SCRIPT_BODY;\n}\nmodule.exports = { buildBootstrapScript };\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(srcDir, 'dist', 'remote', 'remoteManager.js'),
      'class RemoteManager {\n    onConnected(entry, sshSession) {\n        entry.session = sshSession;\n    }\n    disposeHost(entry) {\n        entry.disposed = true;\n    }\n}\nmodule.exports = { RemoteManager };\n',
      'utf8'
    );

    const srcAsar = path.join(tmp, 'src.asar');
    const destAsar = path.join(tmp, 'dest.asar');
    asarEngine.builtinAsar.createPackageWithOptions(srcDir, srcAsar, {});

    const res = packHakimiAsar({ srcAsar, destAsar, skipConfig: true });
    assert.equal(res.ok, true);
    assert.equal(res.inspect.sshSupported, true);
    assert.equal(res.inspect.sshReady, true);

    const bootInjected = asarEngine.builtinAsar.extractFile(destAsar, 'dist/remote/bootstrapScript.js').toString('utf8');
    assert.ok(bootInjected.includes(modularInstaller.TAGS.SSH_BOOTSTRAP_START));
    assert.equal(
      modularInstaller.cleanSshBootstrapSource(bootInjected),
      fs.readFileSync(path.join(srcDir, 'dist', 'remote', 'bootstrapScript.js'), 'utf8')
    );

    const mgrInjected = asarEngine.builtinAsar.extractFile(destAsar, 'dist/remote/remoteManager.js').toString('utf8');
    assert.ok(mgrInjected.includes(modularInstaller.TAGS.SSH_MANAGER_START));
    assert.equal(
      modularInstaller.cleanRemoteManagerSource(mgrInjected),
      fs.readFileSync(path.join(srcDir, 'dist', 'remote', 'remoteManager.js'), 'utf8')
    );

    const disk = modulesConfig.inspectDiskModules(destAsar);
    assert.equal(disk.sshReady, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Stage 2 SSH session registry, session-routed requester, and remote collector work cleanly in isolation', async () => {
  const entry = { hostId: 'ssh:devbox-sg', label: 'devbox-sg' };
  const sshSession = {
    url: 'https://127.0.0.1:22401/',
    socksPort: 54321,
    discovery: { pid: 51995, httpsPort: 22401, httpPort: 10429, lsVersion: '2.34.0', csrfToken: 'tok-remote-123' },
  };
  const rec = sshMod.recordRemoteSession(entry, sshSession);
  assert.equal(rec.origin, 'https://127.0.0.1:22401');
  assert.equal(rec.csrfToken, 'tok-remote-123');
  assert.equal(sshMod.getRemoteSession('ssh:devbox-sg').csrfToken, 'tok-remote-123');

  const fetchCalls = [];
  const fakeSender = {
    session: {
      fetch: async (url, init) => {
        fetchCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        const method = url.split('/').pop();
        if (method === 'GetCascadeTrajectory') {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              numTotalSteps: 1,
              numTotalGeneratorMetadata: 1,
              trajectory: {
                metadata: { workspaceUris: ['file:///home/dev/project'] },
                steps: [
                  {
                    type: 'CORTEX_STEP_TYPE_USER_INPUT',
                    userInput: {
                      items: [{ text: 'hello remote ssh' }],
                      media: [{ uri: 'file:///home/dev/project/screenshot.png', mimeType: 'image/png' }],
                    },
                  },
                ],
              },
            }),
          };
        }
        if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              generatorMetadata: [
                {
                  chatModel: {
                    model: 'MODEL_PLACEHOLDER_M37',
                    usage: {
                      inputTokens: 12000,
                      cacheReadTokens: 8000,
                      outputTokens: 500,
                    },
                    timeToFirstToken: '0.5s',
                    streamingDuration: '5.0s',
                  },
                },
              ],
            }),
          };
        }
        if (method === 'GetUserStatus') {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              userStatus: {
                email: 'remote-cn@example.com',
                userTier: { id: 'free-tier', name: 'Free' },
                cascadeModelConfigData: {
                  clientModelConfigs: [
                    { label: 'Gemini Remote', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M37' } },
                  ],
                },
              },
            }),
          };
        }
        if (method === 'GetAvailableModels') {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              models: [{ model: 'MODEL_PLACEHOLDER_M37', maxTokens: 1048576 }],
            }),
          };
        }
        return { ok: false, status: 404, text: async () => 'not found' };
      },
    },
  };

  const requester = sshMod.createRemoteSessionRequester(fakeSender, rec, 'https://127.0.0.1:22401');
  const convId = '11111111-2222-3333-4444-555555555555';
  const genMeta = await requester.call('GetCascadeTrajectoryGeneratorMetadata', {
    cascadeId: convId,
    generatorMetadataOffset: 0,
    includeMessages: false,
  });
  assert.equal(Array.isArray(genMeta.generatorMetadata), true);
  assert.equal(genMeta.generatorMetadata[0].chatModel.usage.cacheReadTokens, 8000);
  assert.equal(collector.collect, undefined, 'heavy full-trajectory collect() should be removed');

  const tmpAg = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-ssh-hist-'));
  try {
    const hist = await collector.collectTokenHistoryAsync({
      agDir: tmpAg,
      force: true,
      remoteUserStatusOptions: {
        remoteHostId: 'ssh:devbox-sg',
        requestFn: requester.call,
      },
    });
    assert.equal(hist.rawPlanStatus.email, 'remote-cn@example.com');
    assert.equal(hist.cascadeModelConfigs.length, 1);
    assert.equal(hist.cascadeModelConfigs[0].maxTokens, 1048576);
  } finally {
    fs.rmSync(tmpAg, { recursive: true, force: true });
  }

  assert.ok(fetchCalls.length >= 3);
  assert.ok(fetchCalls.every((c) => c.headers['x-codeium-csrf-token'] === 'tok-remote-123'));
  assert.equal(sshMod.forgetRemoteSession('ssh:devbox-sg'), true);
  assert.equal(sshMod.getRemoteSession('ssh:devbox-sg'), null);
});
