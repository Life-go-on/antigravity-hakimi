'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const asarEngine = require(path.join(ROOT, 'payload', 'dist', 'asar-engine.js'));
const iconManager = require(path.join(ROOT, 'payload', 'dist', 'hakimi-icon-manager.js'));
const upgradeHelper = require(path.join(ROOT, 'payload', 'dist', 'hakimi-upgrade-helper.js'));
const modularInstaller = require(path.join(ROOT, 'payload', 'dist', 'modular-installer.js'));
const { packHakimiAsar, PAYLOAD_FILES } = require(path.join(ROOT, 'scripts', 'pack-hakimi-asar.js'));

function writeSyntheticTestImage({ outPath, width, height, format, cornerAlphaZero }) {
  const jxa = `
ObjC.import("AppKit");
ObjC.import("Foundation");
function run(argv) {
  const outPath = argv[0];
  const w = Number(argv[1]);
  const h = Number(argv[2]);
  const fmt = argv[3];
  const transparentCorner = argv[4] === "1";
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, w, h, 8, 4, true, false, $.NSCalibratedRGBColorSpace, 0, 0
  );
  const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  $.NSGraphicsContext.setCurrentContext(ctx);
  if (!transparentCorner) {
    $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.16, 0.52, 0.94, 1.0).setFill;
    $.NSBezierPath.fillRect($.NSMakeRect(0, 0, w, h));
  } else {
    const circle = $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(w * 0.15, h * 0.15, w * 0.7, h * 0.7));
    $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.95, 0.42, 0.18, 1.0).setFill;
    circle.fill;
  }
  ctx.flushGraphics;
  const type = fmt === "jpeg" ? $.NSBitmapImageFileTypeJPEG : $.NSBitmapImageFileTypePNG;
  const data = rep.representationUsingTypeProperties(type, $({}));
  data.writeToFileAtomically(outPath, true);
  return "ok";
}
`;
  const tmpJxa = `${outPath}.jxa`;
  fs.writeFileSync(tmpJxa, jxa, 'utf8');
  try {
    execFileSync('osascript', [
      '-l',
      'JavaScript',
      tmpJxa,
      outPath,
      String(width),
      String(height),
      format,
      cornerAlphaZero ? '1' : '0',
    ]);
  } finally {
    try { fs.unlinkSync(tmpJxa); } catch {}
  }
}

function createSyntheticAppBundle(bundleDir, {
  version = '2.34.0',
  iconPngBuf = Buffer.from('default-icon-png'),
  icnsBuf = Buffer.from('default-icns-bytes'),
  assetsCarBuf = Buffer.from('official-assets-car'),
  iconName = 'AppIcon',
  packWithHakimi = true,
  stateDir = null,
} = {}) {
  const macosDir = path.join(bundleDir, 'Contents', 'MacOS');
  const resDir = path.join(bundleDir, 'Contents', 'Resources');
  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resDir, { recursive: true });

  const mainExec = path.join(macosDir, 'Antigravity');
  fs.writeFileSync(mainExec, '#!/bin/sh\necho hakimi\n', 'utf8');
  fs.chmodSync(mainExec, 0o755);

  fs.writeFileSync(path.join(resDir, 'icon.icns'), icnsBuf);
  if (assetsCarBuf) {
    fs.writeFileSync(path.join(resDir, 'Assets.car'), assetsCarBuf);
  }

  const tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-icon-src-'));
  try {
    fs.mkdirSync(path.join(tmpSrc, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(tmpSrc, 'package.json'), JSON.stringify({ name: 'antigravity', version }));
    fs.writeFileSync(path.join(tmpSrc, 'icon.png'), iconPngBuf);
    fs.writeFileSync(
      path.join(tmpSrc, 'dist', 'utils.js'),
      [
        '"use strict";',
        'function createWindow(url, storageManager, options) {',
        '    const win = {};',
        '    void loadHubWindowUrl(win, url, options);',
        '    return win;',
        '}',
        'const showOrCreateWindow = (port) => {',
        '    const wins = [];',
        '    if (wins.length > 0) {',
        '        wins[0].focus();',
        '    } else {',
        '        createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);',
        '    }',
        '};',
        'function setupNodeWrapper(env) {',
        '    return env;',
        '}',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(path.join(tmpSrc, 'dist', 'preload.js'), '"use strict";\n', 'utf8');

    const rawAsar = path.join(tmpSrc, 'raw.asar');
    asarEngine.builtinAsar.createPackageWithOptions(tmpSrc, rawAsar, {});

    const destAsar = path.join(resDir, 'app.asar');
    let sha256;
    if (packWithHakimi) {
      const packRes = packHakimiAsar({
        srcAsar: rawAsar,
        destAsar,
        skipConfig: true,
        stateDir: stateDir || path.join(tmpSrc, 'state'),
      });
      sha256 = packRes.sha256;
    } else {
      fs.copyFileSync(rawAsar, destAsar);
      sha256 = asarEngine.computeAsarHeaderSha256(destAsar);
    }

    const iconNameXml = iconName
      ? `\n  <key>CFBundleIconName</key>\n  <string>${iconName}</string>`
      : '';
    const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.google.antigravity</string>
  <key>CFBundleExecutable</key>
  <string>Antigravity</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>${iconNameXml}
  <key>ElectronAsarIntegrity</key>
  <dict>
    <key>Resources/app.asar</key>
    <dict>
      <key>algorithm</key>
      <string>SHA256</string>
      <key>hash</key>
      <string>${sha256}</string>
    </dict>
  </dict>
</dict>
</plist>
`;
    fs.writeFileSync(path.join(bundleDir, 'Contents', 'Info.plist'), plistXml, 'utf8');
    return { sha256, destAsar };
  } finally {
    fs.rmSync(tmpSrc, { recursive: true, force: true });
  }
}

test('PAYLOAD_FILES and preload bridge include hakimi-icon-manager and icon IPC methods', () => {
  assert.ok(PAYLOAD_FILES.includes('hakimi-icon-manager.js'), 'hakimi-icon-manager.js must be packed in app.asar');
  const preloadCode = modularInstaller.generateMeterPreloadCode();
  for (const method of [
    'getHakimiIconStatus',
    'pickHakimiIconFile',
    'previewHakimiIcon',
    'applyHakimiIcon',
    'restoreHakimiIcon',
    'getFilePathForDrop',
  ]) {
    assert.ok(preloadCode.includes(method), `Preload must expose ${method}`);
  }
});

test('hakimi-icon-manager strictly blocks official Antigravity.app across all mutating paths', async () => {
  for (const forbidden of [
    '/Applications/Antigravity.app',
    '/Applications/Antigravity.app.orig',
    '/Applications/Antigravity.app/Contents/Info.plist',
  ]) {
    assert.throws(() => iconManager.resolveCurrentBundlePath({ targetAppPath: forbidden }), /official Antigravity\.app/);
    assert.throws(
      () => iconManager.stageIconSwapBundle({ mode: 'restore', targetAppPath: forbidden, stageDir: '/tmp/hakimi-s' }),
      /official Antigravity\.app/
    );
  }
  const applyDenied = await iconManager.applyCustomIcon(
    { inputPath: '/tmp/foo.png' },
    { targetAppPath: '/Applications/Antigravity.app', platform: 'darwin' }
  );
  assert.equal(applyDenied.ok, false);
  assert.match(applyDenied.error, /official Antigravity\.app/);
});

test('renderIconPreview renders masked, raw, transparent-corner, and icns previews accurately on macOS', () => {
  if (process.platform !== 'darwin') return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-icon-preview-test-'));
  try {
    const jpgPath = path.join(tmp, 'photo.jpg');
    writeSyntheticTestImage({ outPath: jpgPath, width: 320, height: 240, format: 'jpeg', cornerAlphaZero: false });

    const maskedRes = iconManager.renderIconPreview({ inputPath: jpgPath, rawIcon: false });
    assert.equal(maskedRes.ok, true);
    assert.equal(maskedRes.mode, 'image');
    assert.equal(maskedRes.w, 320);
    assert.equal(maskedRes.h, 240);
    assert.equal(maskedRes.masked, true);
    assert.equal(maskedRes.hasTransparentCorners, false);
    assert.ok(maskedRes.dataUrl.startsWith('data:image/png;base64,'));

    const rawRes = iconManager.renderIconPreview({ inputPath: jpgPath, rawIcon: true });
    assert.equal(rawRes.ok, true);
    assert.equal(rawRes.masked, false);
    assert.notEqual(rawRes.dataUrl, maskedRes.dataUrl, 'Masked and raw previews should differ');

    const transPath = path.join(tmp, 'logo.png');
    writeSyntheticTestImage({ outPath: transPath, width: 256, height: 256, format: 'png', cornerAlphaZero: true });
    const transRes = iconManager.renderIconPreview({ inputPath: transPath, rawIcon: false });
    assert.equal(transRes.ok, true);
    assert.equal(transRes.hasTransparentCorners, true);
    assert.equal(transRes.masked, false);

    const outIcns = path.join(tmp, 'built.icns');
    const outPng = path.join(tmp, 'built-512.png');
    iconManager.buildMacosIcon({ inputPath: jpgPath, outIcnsPath: outIcns, outPngPath: outPng });
    const icnsPreview = iconManager.renderIconPreview({ inputPath: outIcns });
    assert.equal(icnsPreview.ok, true);
    assert.equal(icnsPreview.mode, 'icns');
    assert.ok(icnsPreview.dataUrl.startsWith('data:image/png;base64,'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('stageIconSwapBundle applies custom icon, auto-snapshots default icon, and restores via official-app, icon-backup, and clean-base-zip', () => {
  if (process.platform !== 'darwin') return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-icon-stage-test-'));
  try {
    const stateDir = path.join(tmp, 'state');
    const customImg = path.join(tmp, 'custom-cat.jpg');
    writeSyntheticTestImage({ outPath: customImg, width: 256, height: 256, format: 'jpeg', cornerAlphaZero: false });

    const defaultIconImg = path.join(tmp, 'official-default.png');
    writeSyntheticTestImage({ outPath: defaultIconImg, width: 256, height: 256, format: 'png', cornerAlphaZero: true });
    const defaultIcnsPath = path.join(tmp, 'official.icns');
    const defaultPngPath = path.join(tmp, 'official-512.png');
    iconManager.buildMacosIcon({
      inputPath: defaultIconImg,
      outIcnsPath: defaultIcnsPath,
      outPngPath: defaultPngPath,
    });
    const officialIcnsBuf = fs.readFileSync(defaultIcnsPath);
    const officialPngBuf = fs.readFileSync(defaultPngPath);
    const officialAssetsBuf = Buffer.from('synthetic-v234-assets-car');

    // Create a synthetic 哈基米.app initially using the official default icon (with Assets.car + CFBundleIconName)
    const targetApp = path.join(tmp, 'Apps', '哈基米.app');
    createSyntheticAppBundle(targetApp, {
      version: '2.34.0',
      iconPngBuf: officialPngBuf,
      icnsBuf: officialIcnsBuf,
      assetsCarBuf: officialAssetsBuf,
      iconName: 'AppIcon',
      packWithHakimi: true,
      stateDir,
    });

    // Initial status without local official app should recognize default via Assets.car/CFBundleIconName
    const stBefore = iconManager.getIconStatus({
      targetAppPath: targetApp,
      stateDir,
      skipDefaultOfficialLookup: true,
    });
    assert.equal(stBefore.ok, true);
    assert.equal(stBefore.isCustomIcon, false);
    assert.ok(stBefore.currentIconDataUrl && stBefore.currentIconDataUrl.startsWith('data:image/png;base64,'));

    // 1. Stage custom icon swap (real codesign --verify --strict!)
    const stageDir1 = path.join(tmp, 'stage-custom');
    const resCustom = iconManager.stageIconSwapBundle(
      {
        mode: 'custom',
        inputPath: customImg,
        rawIcon: false,
        targetAppPath: targetApp,
        stageDir: stageDir1,
        stateDir,
      },
      { skipDefaultOfficialLookup: true }
    );
    assert.equal(resCustom.ok, true, `Custom icon stage failed: ${resCustom.error}`);
    assert.equal(resCustom.masked, true);
    assert.equal(fs.existsSync(path.join(resCustom.stagedAppPath, 'Contents', 'Resources', 'Assets.car')), false);
    assert.equal(
      iconManager.readPlistIconName(path.join(resCustom.stagedAppPath, 'Contents', 'Info.plist')),
      null,
      'Custom icon must strip CFBundleIconName'
    );
    const stagedAsar1 = path.join(resCustom.stagedAppPath, 'Contents', 'Resources', 'app.asar');
    assert.equal(resCustom.asarSha256, asarEngine.computeAsarHeaderSha256(stagedAsar1));
    assert.notEqual(
      Buffer.compare(asarEngine.builtinAsar.extractFile(stagedAsar1, 'icon.png'), officialPngBuf),
      0
    );
    // Original targetApp must remain untouched during staging
    assert.equal(fs.existsSync(path.join(targetApp, 'Contents', 'Resources', 'Assets.car')), true);
    // Auto-backup of official icon must now exist under runtime/official-icon-backup
    const backupMeta = iconManager.readOfficialIconBackupMeta({ stateDir });
    assert.ok(backupMeta, 'Official default icon must be backed up automatically before first custom swap');
    assert.equal(backupMeta.iconName, 'AppIcon');
    assert.ok(backupMeta.assetsCarPath);

    // Simulate swapped app status (now custom, restorable via icon-backup!)
    const stCustom = iconManager.getIconStatus({
      targetAppPath: resCustom.stagedAppPath,
      stateDir,
      skipDefaultOfficialLookup: true,
    });
    assert.equal(stCustom.isCustomIcon, true);
    assert.equal(stCustom.canRestoreDefault, true);
    assert.equal(stCustom.restoreSourceKind, 'icon-backup');

    // 2. Restore via auto-saved `icon-backup` (no official app, no clean-base zip)
    const stageDir2 = path.join(tmp, 'stage-restore-backup');
    const resRestoreBackup = iconManager.stageIconSwapBundle(
      {
        mode: 'restore',
        targetAppPath: resCustom.stagedAppPath,
        stageDir: stageDir2,
        stateDir,
      },
      { skipDefaultOfficialLookup: true }
    );
    assert.equal(resRestoreBackup.ok, true, `Restore from backup failed: ${resRestoreBackup.error}`);
    assert.equal(resRestoreBackup.restoreSourceKind, 'icon-backup');
    assert.equal(
      Buffer.compare(
        fs.readFileSync(path.join(resRestoreBackup.stagedAppPath, 'Contents', 'Resources', 'icon.icns')),
        officialIcnsBuf
      ),
      0
    );
    assert.equal(
      Buffer.compare(
        fs.readFileSync(path.join(resRestoreBackup.stagedAppPath, 'Contents', 'Resources', 'Assets.car')),
        officialAssetsBuf
      ),
      0
    );
    assert.equal(
      iconManager.readPlistIconName(path.join(resRestoreBackup.stagedAppPath, 'Contents', 'Info.plist')),
      'AppIcon'
    );
    assert.equal(
      Buffer.compare(
        asarEngine.builtinAsar.extractFile(
          path.join(resRestoreBackup.stagedAppPath, 'Contents', 'Resources', 'app.asar'),
          'icon.png'
        ),
        officialPngBuf
      ),
      0
    );

    // 3. Restore via `clean-base-zip` (remove backup, create clean-base zip containing synthetic official app)
    fs.rmSync(iconManager.getOfficialIconBackupDir({ stateDir }), { recursive: true, force: true });
    const fakeZipSrcRoot = path.join(tmp, 'zip-src');
    const fakeOfficialInsideZip = path.join(fakeZipSrcRoot, 'Antigravity.app');
    createSyntheticAppBundle(fakeOfficialInsideZip, {
      version: '2.34.0',
      iconPngBuf: officialPngBuf,
      icnsBuf: officialIcnsBuf,
      assetsCarBuf: officialAssetsBuf,
      iconName: 'AppIcon',
      packWithHakimi: false,
    });
    const cleanBaseDir = path.join(stateDir, 'updater', 'clean-base');
    fs.mkdirSync(cleanBaseDir, { recursive: true });
    const cleanZipPath = path.join(cleanBaseDir, 'Antigravity-2.34.0.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', fakeOfficialInsideZip, cleanZipPath]);
    upgradeHelper.writeJsonFileAtomic(path.join(cleanBaseDir, 'clean-base-meta.json'), {
      version: '2.34.0',
      fileName: 'Antigravity-2.34.0.zip',
      sha512: 'fake',
    });

    const stageDir3 = path.join(tmp, 'stage-restore-zip');
    const resRestoreZip = iconManager.stageIconSwapBundle(
      {
        mode: 'restore',
        targetAppPath: resCustom.stagedAppPath,
        stageDir: stageDir3,
        stateDir,
      },
      { skipDefaultOfficialLookup: true }
    );
    assert.equal(resRestoreZip.ok, true, `Restore from clean-base zip failed: ${resRestoreZip.error}`);
    assert.equal(resRestoreZip.restoreSourceKind, 'clean-base-zip');
    assert.equal(
      iconManager.readPlistIconName(path.join(resRestoreZip.stagedAppPath, 'Contents', 'Info.plist')),
      'AppIcon'
    );
    assert.equal(
      Buffer.compare(
        fs.readFileSync(path.join(resRestoreZip.stagedAppPath, 'Contents', 'Resources', 'Assets.car')),
        officialAssetsBuf
      ),
      0
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyCustomIcon hands off to detached hakimi-upgrade-helper with isolated icon result file and atomic swap', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-icon-cold-swap-'));
  try {
    const stateDir = path.join(tmp, 'state');
    const appsDir = path.join(tmp, 'Apps');
    const targetApp = path.join(appsDir, '哈基米.app');
    createSyntheticAppBundle(targetApp, { packWithHakimi: false });

    let capturedJob = null;
    let quitCalled = false;
    iconManager.resetInFlightFlagForTest();

    const applyRes = await iconManager.applyCustomIcon(
      { inputPath: '/tmp/fake-cat.png', rawIcon: false },
      {
        platform: 'darwin',
        targetAppPath: targetApp,
        stateDir,
        homeDir: tmp,
        userDataDir: path.join(tmp, 'userData'),
        quitDelayMs: 0,
        electronOverride: { app: { quit: () => { quitCalled = true; } } },
        workerImpl: async (_action, spec) => {
          const stagedApp = path.join(spec.stageDir, '哈基米.app');
          createSyntheticAppBundle(stagedApp, {
            iconPngBuf: Buffer.from('new-custom-png'),
            icnsBuf: Buffer.from('new-custom-icns'),
            assetsCarBuf: null,
            iconName: null,
            packWithHakimi: false,
          });
          return {
            ok: true,
            mode: 'custom',
            stageDir: spec.stageDir,
            stagedAppPath: stagedApp,
            asarSha256: 'a'.repeat(64),
            masked: true,
          };
        },
        spawnImpl: (_bin, args) => {
          const jobPath = args[args.indexOf('--job') + 1];
          capturedJob = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
          return { pid: 43210, unref() {} };
        },
      }
    );

    assert.equal(applyRes.ok, true);
    assert.equal(applyRes.coldSwapping, true);
    assert.equal(quitCalled, true);
    assert.ok(capturedJob, 'Detached helper job JSON must be written');
    assert.equal(capturedJob.jobKind, 'icon');
    assert.equal(capturedJob.iconMode, 'custom');
    assert.equal(capturedJob.resultPath, iconManager.getIconResultPath({ stateDir }));

    // Execute the captured cold-swap job directly through hakimi-upgrade-helper
    const relaunched = [];
    const execRes = upgradeHelper.executeColdUpgradeJob(capturedJob, {
      skipStop: true,
      skipMacRegistration: true,
      sleepImpl: () => {},
      spawnImpl: (bin, args) => {
        relaunched.push({ bin, args });
        return { unref() {} };
      },
    });
    assert.equal(execRes.ok, true);
    assert.equal(execRes.jobKind, 'icon');
    assert.equal(execRes.iconMode, 'custom');
    assert.equal(relaunched.length, 1);
    assert.equal(fs.existsSync(capturedJob.stagingRootDir), false, 'Staging dir must be cleaned after swap');
    assert.equal(
      fs.readFileSync(path.join(targetApp, 'Contents', 'Resources', 'icon.icns'), 'utf8'),
      'new-custom-icns'
    );
    // Dedicated icon result file written, upgrade result file untouched!
    assert.equal(fs.existsSync(iconManager.getIconResultPath({ stateDir })), true);
    assert.equal(fs.existsSync(upgradeHelper.getUpgradeResultPath({ stateDir })), false);

    // Consuming lastResult via getIconStatus clears it
    iconManager.resetInFlightFlagForTest();
    const stAfter = iconManager.getIconStatus({
      targetAppPath: targetApp,
      stateDir,
      skipDefaultOfficialLookup: true,
      consumeLastResult: true,
    });
    assert.equal(stAfter.lastResult?.ok, true);
    assert.equal(stAfter.lastResult?.iconMode, 'custom');
    assert.equal(fs.existsSync(iconManager.getIconResultPath({ stateDir })), false);
  } finally {
    iconManager.resetInFlightFlagForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('renderer Settings icon card supports live preview, mask toggle, modal apply/restore, and SSH hiding', async () => {
  const coreCode = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-core.js'), 'utf8');
  const rendererCode = fs.readFileSync(path.join(ROOT, 'payload', 'dist', 'meter-renderer.js'), 'utf8');

  class FakeElement {
    constructor(tag) {
      this.tagName = String(tag || 'div').toUpperCase();
      this.id = '';
      this.className = '';
      this.hidden = false;
      this.disabled = false;
      this.checked = false;
      this.value = '';
      this.style = {
        display: '',
        setProperty(k, v) { this[k] = v; },
        removeProperty(k) { delete this[k]; },
      };
      this.attributes = new Map();
      this.children = [];
      this.parentElement = null;
      this.shadowRoot = null;
      this._textContent = '';
      this._innerHTML = '';
      this._listeners = new Map();
      this.rect = { left: 0, top: 0, width: 120, height: 32, right: 120, bottom: 32 };
      const self = this;
      this.classList = {
        add(...cs) {
          const set = new Set(self.className.split(/\s+/).filter(Boolean));
          for (const c of cs) set.add(c);
          self.className = [...set].join(' ');
        },
        remove(...cs) {
          const set = new Set(self.className.split(/\s+/).filter(Boolean));
          for (const c of cs) set.delete(c);
          self.className = [...set].join(' ');
        },
        toggle(c, force) {
          if (force === undefined) {
            if (this.contains(c)) this.remove(c); else this.add(c);
          } else if (force) this.add(c);
          else this.remove(c);
        },
        contains(c) { return self.className.split(/\s+/).includes(c); },
      };
    }
    get textContent() { return this._textContent; }
    set textContent(v) { this._textContent = String(v ?? ''); }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(v) {
      this._innerHTML = String(v ?? '');
      this.children = [];
      const stripped = this._innerHTML.replace(/<style\b[\s\S]*?<\/style>/gi, '');
      const tagRe = /<([a-z][a-z0-9-]*)\b([^>]*)>/gi;
      let m;
      while ((m = tagRe.exec(stripped)) !== null) {
        const child = new FakeElement(m[1]);
        const attrStr = m[2] || '';
        const attrRe = /([a-zA-Z0-9_:-]+)(?:="([^"]*)")?/g;
        let am;
        while ((am = attrRe.exec(attrStr)) !== null) {
          const k = am[1];
          const val = am[2] ?? '';
          if (k === 'id') child.id = val;
          else if (k === 'class') child.className = val;
          else if (k === 'hidden') child.hidden = true;
          else if (k === 'checked') child.checked = true;
          child.attributes.set(k, val);
        }
        child.parentElement = this;
        this.children.push(child);
      }
    }
    attachShadow() { this.shadowRoot = new FakeElement('shadow-root'); return this.shadowRoot; }
    appendChild(c) { if (c.parentElement) c.remove(); c.parentElement = this; this.children.push(c); return c; }
    replaceChildren(...nodes) { this.children = []; for (const n of nodes) if (n) this.appendChild(n); }
    insertBefore(c, ref) {
      if (!ref) return this.appendChild(c);
      if (c.parentElement) c.remove();
      const idx = this.children.indexOf(ref);
      c.parentElement = this;
      if (idx === -1) this.children.push(c);
      else this.children.splice(idx, 0, c);
      return c;
    }
    remove() {
      if (!this.parentElement) return;
      const idx = this.parentElement.children.indexOf(this);
      if (idx >= 0) this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
    }
    contains(target) { return target === this || this.children.some((c) => c.contains(target)); }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    hasAttribute(k) { return this.attributes.has(k); }
    setAttribute(k, v) { this.attributes.set(k, String(v)); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); }
    removeAttribute(k) { this.attributes.delete(k); }
    getBoundingClientRect() { return { ...this.rect }; }
    addEventListener(type, fn) { if (!this._listeners.has(type)) this._listeners.set(type, []); this._listeners.get(type).push(fn); }
    removeEventListener() {}
    dispatch(type, ev = {}) {
      const list = this._listeners.get(type) || [];
      for (const fn of list) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...ev });
    }
    getElementById(id) {
      for (const c of this.children) {
        if (c.id === id) return c;
        const nested = c.getElementById(id);
        if (nested) return nested;
      }
      return null;
    }
    querySelector(sel) {
      if (sel === '[class*="@container/titlebar"]') {
        if (this.className.includes('@container/titlebar')) return this;
        for (const c of this.children) { const r = c.querySelector(sel); if (r) return r; }
      }
      return null;
    }
    querySelectorAll() { return []; }
    closest() { return null; }
  }

  const mountScenario = ({ isRemote = false, apiOverrides = {} } = {}) => {
    const body = new FakeElement('body');
    const titlebar = new FakeElement('div');
    titlebar.className = 'flex w-full @container/titlebar';
    body.appendChild(titlebar);
    const doc = {
      body,
      documentElement: body,
      head: new FakeElement('head'),
      createElement: (tag) => new FakeElement(tag),
      createElementNS: (_ns, tag) => new FakeElement(tag),
      createDocumentFragment: () => new FakeElement('fragment'),
      getElementById: (id) => body.getElementById(id),
      querySelector: (sel) => body.querySelector(sel),
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    };
    const previewCalls = [];
    const applyCalls = [];
    const restoreCalls = [];

    const sb = {
      console,
      Math,
      Date,
      JSON,
      Object,
      Array,
      Map,
      Set,
      Promise,
      RegExp,
      Number,
      String,
      Boolean,
      Error,
      URL,
      AbortController: class { abort() {} },
      ResizeObserver: class { observe() {} disconnect() {} },
      MutationObserver: class { observe() {} disconnect() {} },
      location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/' },
      navigator: { platform: 'MacIntel', clipboard: { writeText() {} } },
      innerWidth: 1280,
      innerHeight: 800,
      document: doc,
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      getComputedStyle: () => ({ paddingRight: '8px', backgroundColor: 'rgb(24,24,24)' }),
      setInterval: () => 1,
      clearInterval() {},
      setTimeout: () => 1,
      clearTimeout() {},
      requestAnimationFrame: (cb) => { cb(); return 1; },
      cancelAnimationFrame() {},
      addEventListener() {},
      removeEventListener() {},
      __AGContextMeterRemote: isRemote ? { kind: 'ssh', hostId: 'linux-box', label: 'linux-box' } : null,
      contextMeterAPI: {
        getModulesStatus: async () => ({
          ok: true,
          data: { modules: { meter: { enabled: true }, chinese: { enabled: true, language: 'zh-CN' } } },
          disk: { found: true, chinese: true, chineseReady: true, meterReady: true },
        }),
        getHakimiUpgradeStatus: async () => ({ ok: true, supported: true, status: 'idle', ready: false }),
        onHakimiUpgradeChanged: () => () => {},
        getHakimiIconStatus: async () => ({
          ok: true,
          supported: true,
          isCustomIcon: true,
          canRestoreDefault: true,
          currentIconDataUrl: 'data:image/png;base64,CURICON',
          lastResult: { ok: true, iconMode: 'custom' },
        }),
        pickHakimiIconFile: async () => ({ ok: true, canceled: false, filePath: '/Users/dev/Pictures/cat.jpg' }),
        previewHakimiIcon: async (payload) => {
          previewCalls.push(payload);
          return {
            ok: true,
            mode: 'image',
            w: 512,
            h: 512,
            masked: !payload.rawIcon,
            hasTransparentCorners: false,
            fileName: 'cat.jpg',
            inputPath: payload.inputPath,
            dataUrl: payload.rawIcon ? 'data:image/png;base64,RAWPREVIEW' : 'data:image/png;base64,MASKPREVIEW',
          };
        },
        applyHakimiIcon: async (payload) => {
          applyCalls.push(payload);
          return { ok: true, coldSwapping: true, mode: 'custom' };
        },
        restoreHakimiIcon: async (payload) => {
          restoreCalls.push(payload);
          return { ok: true, coldSwapping: true, mode: 'restore' };
        },
        ...apiOverrides,
      },
    };
    sb.window = sb;
    sb.globalThis = sb;
    vm.runInNewContext(`${coreCode}\n${rendererCode}`, sb, { filename: 'meter-renderer-icon-test.js' });
    const hostEl = doc.getElementById('ag-context-meter');
    return { sb, shadow: hostEl.shadowRoot, previewCalls, applyCalls, restoreCalls };
  };

  // 1. Local macOS window flow
  const local = mountScenario({ isRemote: false });
  await local.sb.__AGContextMeter.refreshHakimiIconForTest({ consumeLastResult: true });
  const iconCard = local.shadow.getElementById('hakimi-icon-card');
  const curImg = local.shadow.getElementById('hakimi-icon-cur-img');
  const restoreBtn = local.shadow.getElementById('btn-hakimi-icon-restore');
  const applyBtn = local.shadow.getElementById('btn-hakimi-icon-apply');
  const pickBtn = local.shadow.getElementById('btn-hakimi-icon-pick');
  const maskChk = local.shadow.getElementById('chk-hakimi-icon-mask');
  const nextImg = local.shadow.getElementById('hakimi-icon-next-img');
  const iconModal = local.shadow.getElementById('hakimi-icon-modal');
  const modalConfirm = local.shadow.getElementById('btn-modal-icon-confirm');

  assert.equal(iconCard.hidden, false, 'Icon card should be visible in local macOS window');
  assert.equal(curImg.getAttribute('src'), 'data:image/png;base64,CURICON');
  assert.equal(restoreBtn.hidden, false, 'Restore button should be visible when custom icon is active');
  assert.equal(applyBtn.hidden, true, 'Apply button should stay hidden before picking an image');
  assert.ok(local.shadow.getElementById('hakimi-icon-result-text').textContent.includes('生效'));

  // Pick image -> triggers live masked preview
  pickBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(local.previewCalls.length, 1);
  assert.equal(local.previewCalls[0].rawIcon, false);
  assert.equal(nextImg.getAttribute('src'), 'data:image/png;base64,MASKPREVIEW');
  assert.equal(applyBtn.hidden, false, 'Apply button should appear once preview succeeds');

  // Toggle mask checkbox OFF -> triggers raw preview immediately
  maskChk.checked = false;
  maskChk.dispatch('change');
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(local.previewCalls.length, 2);
  assert.equal(local.previewCalls[1].rawIcon, true);
  assert.equal(nextImg.getAttribute('src'), 'data:image/png;base64,RAWPREVIEW');

  // Click Apply -> opens modal -> confirm invokes applyHakimiIcon with rawIcon: true
  applyBtn.dispatch('click');
  assert.equal(iconModal.hidden, false);
  modalConfirm.dispatch('click');
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(local.applyCalls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(local.applyCalls[0])), {
    inputPath: '/Users/dev/Pictures/cat.jpg',
    rawIcon: true,
  });
  local.sb.__AGContextMeter.dispose();

  // 1b. Restore modal + failure keeps current app untouched & surfaces error
  const failScenario = mountScenario({
    isRemote: false,
    apiOverrides: {
      restoreHakimiIcon: async () => ({ ok: false, error: 'codesign failed in sandbox' }),
    },
  });
  await failScenario.sb.__AGContextMeter.refreshHakimiIconForTest();
  failScenario.shadow.getElementById('btn-hakimi-icon-restore').dispatch('click');
  assert.equal(failScenario.shadow.getElementById('hakimi-icon-modal').hidden, false);
  failScenario.shadow.getElementById('btn-modal-icon-confirm').dispatch('click');
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(failScenario.shadow.getElementById('hakimi-icon-modal').hidden, false);
  assert.equal(failScenario.shadow.getElementById('btn-modal-icon-confirm').disabled, false);
  assert.ok(failScenario.shadow.getElementById('modal-icon-feedback').textContent.includes('codesign failed in sandbox'));
  failScenario.sb.__AGContextMeter.dispose();

  // 2. Remote SSH window MUST hide icon card
  const remote = mountScenario({ isRemote: true });
  await remote.sb.__AGContextMeter.refreshHakimiIconForTest();
  assert.equal(remote.shadow.getElementById('hakimi-icon-card').hidden, true, 'SSH remote window must hide icon card');
  remote.sb.__AGContextMeter.dispose();
});
