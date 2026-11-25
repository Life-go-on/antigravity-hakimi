#!/usr/bin/env node
'use strict';

/**
 * Self-contained macOS Application Icon Manager for 哈基米.app.
 *
 * Shared by:
 * - CLI tools (`scripts/build-macos-icon.js`, `scripts/replace-asar-icon.js`, `build-hakimi.sh`, `set-hakimi-icon.sh`)
 * - In-app Electron main process (`payload/dist/meter-main.js`) for live preview, custom icon
 *   replacement, and official default icon restoration via APFS CoW staging + atomic cold-swap.
 *
 * Safety & Isolation Guarantees:
 * - Strictly refuses to mutate `/Applications/Antigravity.app`, `.orig`, or symlinks to them.
 * - Stages the modified bundle in an isolated temp directory (covered by startup Orphan GC)
 *   and verifies `codesign --verify --strict` BEFORE quitting the running `哈基米.app`.
 * - Hands off final exit-barrier + APFS atomic swap + relaunch to zero-dependency
 *   `hakimi-upgrade-helper.js`, with automatic `.prev` rollback on any failure.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const asarEngine = require('./asar-engine');
const { verifyHeaderMetadataPreserved } = require('./hakimi-asar-packer');
const builder = require('./hakimi-builder');
const upgradeHelper = require('./hakimi-upgrade-helper');

const {
  assertNotOfficialAntigravityApp,
  isOfficialAntigravityPath,
  readAsarHeader,
  computeAsarHeaderSha256,
  builtinAsar,
  withNoAsar,
  getHakimiAppPath,
} = asarEngine;

const SUPPORTED_ICON_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'heic',
  'heif',
  'icns',
  'tiff',
  'tif',
  'bmp',
  'gif',
];

const MAX_INPUT_FILE_BYTES = 50 * 1024 * 1024;
const ICON_RESULT_FILE_NAME = 'hakimi-icon-last-result.json';
const OFFICIAL_ICON_BACKUP_DIR_NAME = 'official-icon-backup';

const ICONSET_SPECS = [
  { name: 'icon_16x16.png', size: 16 },
  { name: 'icon_16x16@2x.png', size: 32 },
  { name: 'icon_32x32.png', size: 32 },
  { name: 'icon_32x32@2x.png', size: 64 },
  { name: 'icon_128x128.png', size: 128 },
  { name: 'icon_128x128@2x.png', size: 256 },
  { name: 'icon_256x256.png', size: 256 },
  { name: 'icon_256x256@2x.png', size: 512 },
  { name: 'icon_512x512.png', size: 512 },
];

const JXA_RENDER_SCRIPT = `
ObjC.import("AppKit");
ObjC.import("Foundation");

function run(argv) {
  const inPath = argv[0];
  const outPath = argv[1];
  const rawMode = argv[2] === "1";
  const outSize = Number(argv[3]) > 0 ? Math.round(Number(argv[3])) : 1024;

  const data = $.NSData.dataWithContentsOfFile(inPath);
  if (data.isNil()) throw new Error("Failed to read normalized PNG");
  const srcRep = $.NSBitmapImageRep.imageRepWithData(data);
  if (srcRep.isNil()) throw new Error("Failed to decode bitmap");

  const w = Number(srcRep.pixelsWide);
  const h = Number(srcRep.pixelsHigh);
  if (!(w > 0 && h > 0)) throw new Error("Invalid image dimensions");

  // Lock NSImage size to exact pixel dimensions so Retina DPI metadata never scales draw output
  srcRep.size = $.NSMakeSize(w, h);
  const img = $.NSImage.alloc.initWithSize($.NSMakeSize(w, h));
  img.addRepresentation(srcRep);

  const side = Math.min(w, h);
  const cropX = Math.floor((w - side) / 2);
  const cropY = Math.floor((h - side) / 2);

  function alphaAt(px, py) {
    const c = srcRep.colorAtXY(px, py);
    return c.isNil() ? 1.0 : Number(c.alphaComponent);
  }

  const hasTransparentCorners =
    Boolean(srcRep.hasAlpha) &&
    alphaAt(cropX, cropY) < 0.06 &&
    alphaAt(cropX + side - 1, cropY) < 0.06 &&
    alphaAt(cropX, cropY + side - 1) < 0.06 &&
    alphaAt(cropX + side - 1, cropY + side - 1) < 0.06;

  const outRep =
    $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null,
      outSize,
      outSize,
      8,
      4,
      true,
      false,
      $.NSCalibratedRGBColorSpace,
      0,
      0
    );
  const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(outRep);
  $.NSGraphicsContext.setCurrentContext(ctx);
  ctx.imageInterpolation = $.NSImageInterpolationHigh;

  const useSquircle = !rawMode && !hasTransparentCorners;
  const inset = Math.round((100 * outSize) / 1024);
  const innerSize = outSize - inset * 2;
  const radius = Math.round((185 * outSize) / 1024);
  const dstRect = useSquircle
    ? $.NSMakeRect(inset, inset, innerSize, innerSize)
    : $.NSMakeRect(0, 0, outSize, outSize);

  if (useSquircle) {
    const clip = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(dstRect, radius, radius);
    clip.addClip;
  }

  const srcRect = $.NSMakeRect(cropX, cropY, side, side);
  img.drawInRectFromRectOperationFraction(
    dstRect,
    srcRect,
    $.NSCompositingOperationSourceOver,
    1.0
  );
  ctx.flushGraphics;

  const pngData = outRep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  if (pngData.isNil() || !pngData.writeToFileAtomically(outPath, true)) {
    throw new Error("Failed to write rendered PNG");
  }

  return JSON.stringify({
    w: w,
    h: h,
    side: side,
    masked: useSquircle,
    hasTransparentCorners: hasTransparentCorners,
  });
}
`;

let coldIconSwapInFlight = false;

function resolveMacTool(absPath, fallbackName) {
  try {
    if (fs.existsSync(absPath)) return absPath;
  } catch {}
  return fallbackName;
}

function resolveElectron() {
  try {
    const mod = require('electron');
    if (mod && typeof mod === 'object') return mod;
  } catch {}
  return null;
}

function resolveCurrentBundlePath(options = {}) {
  if (options.targetAppPath) {
    const p = path.resolve(String(options.targetAppPath));
    if (!options.allowOfficialForTest) {
      assertNotOfficialAntigravityApp(p, '应用图标目标');
    }
    return p;
  }
  const execPath = options.execPath || process.execPath || '';
  if (execPath) {
    const m = path.resolve(execPath).match(/^(.+?\.app)\/Contents\/MacOS\/[^/]+$/);
    if (m && m[1]) {
      if (!isOfficialAntigravityPath(m[1]) || options.allowOfficialForTest) {
        return m[1];
      }
    }
  }
  const fallback = getHakimiAppPath();
  if (!options.allowOfficialForTest) {
    assertNotOfficialAntigravityApp(fallback, '应用图标目标');
  }
  return fallback;
}

function resolveWorkerRuntime(options = {}) {
  if (options.nodeBin) {
    return { bin: String(options.nodeBin), envExtra: options.nodeEnvExtra || {} };
  }
  if (process.versions && process.versions.electron) {
    return {
      bin: options.execPath || process.execPath,
      envExtra: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return {
    bin: options.execPath || process.execPath,
    envExtra: {},
  };
}

function resolveStateDir(options = {}) {
  return options.stateDir
    ? path.resolve(String(options.stateDir))
    : upgradeHelper.getDefaultStateDir();
}

function getIconResultPath(options = {}) {
  return path.join(upgradeHelper.getRuntimeDir({ stateDir: resolveStateDir(options) }), ICON_RESULT_FILE_NAME);
}

function getOfficialIconBackupDir(options = {}) {
  return path.join(
    upgradeHelper.getRuntimeDir({ stateDir: resolveStateDir(options) }),
    OFFICIAL_ICON_BACKUP_DIR_NAME
  );
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function validateInputIconFile(rawPath) {
  const inputPath = path.resolve(String(rawPath || ''));
  if (!rawPath || !fs.existsSync(inputPath)) {
    throw new Error(`找不到图标文件: ${rawPath || inputPath}`);
  }
  const stat = fs.statSync(inputPath);
  if (!stat.isFile()) {
    throw new Error(`指定的路径不是有效文件: ${inputPath}`);
  }
  if (stat.size <= 0) {
    throw new Error(`图标文件为空: ${inputPath}`);
  }
  if (stat.size > MAX_INPUT_FILE_BYTES) {
    throw new Error(`图标文件超过 50MB 限制，请选择更小的图片`);
  }
  return inputPath;
}

/**
 * Convert local image (PNG/JPG/WebP/HEIC/ICNS/etc.) into macOS `.icns` and `512x512` Dock PNG.
 */
function buildMacosIcon(rawOpts = {}) {
  const execImpl = rawOpts.execFileSync || execFileSync;
  const inputPath = validateInputIconFile(rawOpts.inputPath);
  const outIcnsPath = path.resolve(String(rawOpts.outIcnsPath || ''));
  const outPngPath = path.resolve(String(rawOpts.outPngPath || ''));
  const rawIcon = Boolean(rawOpts.rawIcon);

  assertNotOfficialAntigravityApp(outIcnsPath, 'write custom icns');
  assertNotOfficialAntigravityApp(outPngPath, 'write custom icon.png');

  fs.mkdirSync(path.dirname(outIcnsPath), { recursive: true });
  fs.mkdirSync(path.dirname(outPngPath), { recursive: true });

  const sipsBin = resolveMacTool('/usr/bin/sips', 'sips');
  const osascriptBin = resolveMacTool('/usr/bin/osascript', 'osascript');
  const iconutilBin = resolveMacTool('/usr/bin/iconutil', 'iconutil');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-icon-'));
  try {
    if (inputPath.toLowerCase().endsWith('.icns')) {
      try {
        const fmtOut = execImpl(sipsBin, ['-g', 'format', inputPath], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (!/format:\s*icns/i.test(fmtOut)) {
          throw new Error('not an icns file');
        }
      } catch {
        throw new Error(`无效的 .icns 图标文件: ${inputPath}`);
      }

      fs.copyFileSync(inputPath, outIcnsPath);
      execImpl(
        sipsBin,
        ['-s', 'format', 'png', '-z', '512', '512', inputPath, '--out', outPngPath],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );

      if (!fs.existsSync(outIcnsPath) || fs.statSync(outIcnsPath).size === 0) {
        throw new Error(`输出 .icns 写入失败: ${outIcnsPath}`);
      }
      if (!fs.existsSync(outPngPath) || fs.statSync(outPngPath).size === 0) {
        throw new Error(`输出 512x512 PNG 写入失败: ${outPngPath}`);
      }

      return {
        ok: true,
        mode: 'icns',
        masked: false,
        hasTransparentCorners: true,
        outIcnsPath,
        outPngPath,
      };
    }

    const normalizedPng = path.join(workDir, 'normalized.png');
    try {
      execImpl(sipsBin, ['-s', 'format', 'png', inputPath, '--out', normalizedPng], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new Error(
        `无法读取或转换图标图片: ${inputPath}（支持 PNG / JPG / WebP / HEIC / ICNS 等格式）`
      );
    }

    const jxaFile = path.join(workDir, 'render.jxa');
    const base1024Png = path.join(workDir, 'base1024.png');
    fs.writeFileSync(jxaFile, JXA_RENDER_SCRIPT, 'utf8');

    const jxaStdout = execImpl(
      osascriptBin,
      ['-l', 'JavaScript', jxaFile, normalizedPng, base1024Png, rawIcon ? '1' : '0', '1024'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
    const renderMeta = JSON.parse(jxaStdout);

    const iconsetDir = path.join(workDir, 'AppIcon.iconset');
    fs.mkdirSync(iconsetDir, { recursive: true });
    for (const spec of ICONSET_SPECS) {
      const target = path.join(iconsetDir, spec.name);
      execImpl(
        sipsBin,
        ['-z', String(spec.size), String(spec.size), base1024Png, '--out', target],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
    }
    fs.copyFileSync(base1024Png, path.join(iconsetDir, 'icon_512x512@2x.png'));

    execImpl(iconutilBin, ['-c', 'icns', iconsetDir, '-o', outIcnsPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    fs.copyFileSync(path.join(iconsetDir, 'icon_512x512.png'), outPngPath);

    if (!fs.existsSync(outIcnsPath) || fs.statSync(outIcnsPath).size === 0) {
      throw new Error(`生成 .icns 失败: ${outIcnsPath}`);
    }
    if (!fs.existsSync(outPngPath) || fs.statSync(outPngPath).size === 0) {
      throw new Error(`生成 512x512 PNG 失败: ${outPngPath}`);
    }

    return {
      ok: true,
      mode: 'image',
      w: renderMeta.w,
      h: renderMeta.h,
      side: renderMeta.side,
      masked: Boolean(renderMeta.masked),
      hasTransparentCorners: Boolean(renderMeta.hasTransparentCorners),
      outIcnsPath,
      outPngPath,
    };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Render a fast PNG data-URL preview using the exact same crop & squircle-mask pipeline
 * without building the full multi-resolution `.icns` iconset.
 */
function renderIconPreview(rawOpts = {}) {
  const execImpl = rawOpts.execFileSync || execFileSync;
  const inputPath = validateInputIconFile(rawOpts.inputPath);
  const rawIcon = Boolean(rawOpts.rawIcon);
  const previewSize = Number.isFinite(Number(rawOpts.previewSize))
    ? Math.max(64, Math.min(512, Math.round(Number(rawOpts.previewSize))))
    : 256;

  const sipsBin = resolveMacTool('/usr/bin/sips', 'sips');
  const osascriptBin = resolveMacTool('/usr/bin/osascript', 'osascript');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-icon-preview-'));
  try {
    const outPng = path.join(workDir, 'preview.png');
    if (inputPath.toLowerCase().endsWith('.icns')) {
      try {
        const fmtOut = execImpl(sipsBin, ['-g', 'format', inputPath], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (!/format:\s*icns/i.test(fmtOut)) {
          throw new Error('not an icns file');
        }
      } catch {
        throw new Error(`无效的 .icns 图标文件: ${path.basename(inputPath)}`);
      }
      execImpl(
        sipsBin,
        ['-s', 'format', 'png', '-z', String(previewSize), String(previewSize), inputPath, '--out', outPng],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const buf = fs.readFileSync(outPng);
      return {
        ok: true,
        mode: 'icns',
        masked: false,
        hasTransparentCorners: true,
        fileName: path.basename(inputPath),
        inputPath,
        dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
      };
    }

    const normalizedPng = path.join(workDir, 'normalized.png');
    try {
      execImpl(sipsBin, ['-s', 'format', 'png', inputPath, '--out', normalizedPng], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new Error(
        `无法读取图片: ${path.basename(inputPath)}（支持 PNG / JPG / WebP / HEIC / ICNS 等格式）`
      );
    }

    const jxaFile = path.join(workDir, 'render.jxa');
    fs.writeFileSync(jxaFile, JXA_RENDER_SCRIPT, 'utf8');
    const jxaStdout = execImpl(
      osascriptBin,
      ['-l', 'JavaScript', jxaFile, normalizedPng, outPng, rawIcon ? '1' : '0', String(previewSize)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
    const renderMeta = JSON.parse(jxaStdout);
    const buf = fs.readFileSync(outPng);

    return {
      ok: true,
      mode: 'image',
      w: renderMeta.w,
      h: renderMeta.h,
      side: renderMeta.side,
      masked: Boolean(renderMeta.masked),
      hasTransparentCorners: Boolean(renderMeta.hasTransparentCorners),
      fileName: path.basename(inputPath),
      inputPath,
      dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
    };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Swap only root `icon.png` inside an already-built app.asar while keeping every
 * other entry, injected hook, and unpacked/executable metadata intact.
 */
function replaceAsarIcon(rawOpts = {}) {
  const targetAsar = path.resolve(String(rawOpts.asarPath || ''));
  const iconPngPath = path.resolve(String(rawOpts.iconPng || ''));

  if (!targetAsar || !fs.existsSync(targetAsar)) {
    throw new Error(`Target ASAR not found: ${targetAsar}`);
  }
  assertNotOfficialAntigravityApp(targetAsar, 'replace icon in ASAR');

  if (!iconPngPath || !fs.existsSync(iconPngPath) || !fs.statSync(iconPngPath).isFile()) {
    throw new Error(`Icon PNG not found: ${iconPngPath}`);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakimi-asar-icon-'));
  const tmpDestAsar = `${targetAsar}.icon_tmp_${process.pid}_${Date.now()}`;

  try {
    withNoAsar(() => {
      builtinAsar.extractAll(targetAsar, workDir);

      const destIconPng = path.join(workDir, 'icon.png');
      fs.copyFileSync(iconPngPath, destIconPng);
      fs.chmodSync(destIconPng, 0o644);

      builtinAsar.createPackageWithOptions(workDir, tmpDestAsar, {
        unpackDir: '**/chrome-devtools-mcp',
        skipUnpackedWrite: true,
      });

      verifyHeaderMetadataPreserved(targetAsar, tmpDestAsar, new Set(['icon.png']));

      const { header } = readAsarHeader(tmpDestAsar);
      const iconNode = header?.files?.['icon.png'];
      if (!iconNode || iconNode.files || iconNode.unpacked || iconNode.executable) {
        throw new Error('Packed ASAR icon.png metadata invalid after icon swap');
      }

      const sha256 = computeAsarHeaderSha256(tmpDestAsar);
      fs.renameSync(tmpDestAsar, targetAsar);

      if (rawOpts.hashOut) {
        const hashOutPath = path.resolve(String(rawOpts.hashOut));
        fs.mkdirSync(path.dirname(hashOutPath), { recursive: true });
        fs.writeFileSync(hashOutPath, `${sha256}\n`, 'utf8');
      }
    });

    const sha256 = computeAsarHeaderSha256(targetAsar);
    return { ok: true, targetAsar, sha256 };
  } finally {
    try {
      if (fs.existsSync(tmpDestAsar)) fs.unlinkSync(tmpDestAsar);
    } catch {}
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

function readPlistIconName(plistPath, options = {}) {
  if (!plistPath || !fs.existsSync(plistPath)) return null;
  const execImpl = options.execFileSync || execFileSync;
  if (options.useXmlFallback !== true && process.platform === 'darwin' && fs.existsSync('/usr/bin/plutil')) {
    try {
      const jsonText = execImpl('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const obj = JSON.parse(jsonText);
      const name = typeof obj?.CFBundleIconName === 'string' ? obj.CFBundleIconName.trim() : '';
      return name || null;
    } catch {}
  }
  try {
    const xml = fs.readFileSync(plistPath, 'utf8');
    const m = xml.match(/<key>\s*CFBundleIconName\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Update ElectronAsarIntegrity hash and CFBundleIconName in target Info.plist.
 */
function updateInfoPlistForIcon(plistPath, newAsarHash, { mode = 'custom', restoreIconName = null } = {}, options = {}) {
  const execImpl = options.execFileSync || execFileSync;
  if (!/^[0-9a-f]{64}$/i.test(String(newAsarHash || ''))) {
    throw new Error(`非法 ASAR 摘要长度: ${newAsarHash}`);
  }
  assertNotOfficialAntigravityApp(plistPath, '更新 Info.plist');

  if (options.useXmlFallback !== true && process.platform === 'darwin' && fs.existsSync('/usr/bin/plutil')) {
    const jsonText = execImpl('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const plistObj = JSON.parse(jsonText);
    if (!plistObj.ElectronAsarIntegrity || typeof plistObj.ElectronAsarIntegrity !== 'object') {
      plistObj.ElectronAsarIntegrity = {};
    }
    plistObj.ElectronAsarIntegrity['Resources/app.asar'] = {
      algorithm: 'SHA256',
      hash: newAsarHash,
    };
    if (mode === 'restore' && restoreIconName) {
      plistObj.CFBundleIconName = String(restoreIconName);
    } else {
      delete plistObj.CFBundleIconName;
    }
    const tmpJson = `${plistPath}.tmp.${process.pid}.${Date.now()}.json`;
    try {
      fs.writeFileSync(tmpJson, JSON.stringify(plistObj), 'utf8');
      execImpl('/usr/bin/plutil', ['-convert', 'xml1', '-o', plistPath, tmpJson], { stdio: 'pipe' });
    } finally {
      upgradeHelper.unlinkIfExists(tmpJson);
    }
    return;
  }

  let xml = fs.readFileSync(plistPath, 'utf8');
  const hashRe = /(<key>\s*Resources\/app\.asar\s*<\/key>\s*<dict>[\s\S]*?<key>\s*hash\s*<\/key>\s*<string>)([^<]*)(<\/string>)/;
  if (hashRe.test(xml)) {
    xml = xml.replace(hashRe, `$1${newAsarHash}$3`);
  } else {
    xml = xml.replace(
      /<\/dict>\s*<\/plist>/,
      `<key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>${newAsarHash}</string></dict></dict></dict></plist>`
    );
  }
  xml = xml.replace(/<key>\s*CFBundleIconName\s*<\/key>\s*<string>[^<]*<\/string>\s*/g, '');
  if (mode === 'restore' && restoreIconName) {
    const escaped = String(restoreIconName).replace(/[<>&]/g, '');
    xml = xml.replace(/<\/dict>\s*<\/plist>/, `<key>CFBundleIconName</key><string>${escaped}</string></dict></plist>`);
  }
  fs.writeFileSync(plistPath, xml, 'utf8');
}

function findLocalOfficialApp(options = {}) {
  const candidates = [];
  if (options.officialAppPath) {
    candidates.push(path.resolve(String(options.officialAppPath)));
  } else if (options.skipDefaultOfficialLookup !== true) {
    candidates.push('/Applications/Antigravity.app.orig', '/Applications/Antigravity.app');
  }
  return withNoAsar(() => {
    for (const candidate of candidates) {
      try {
        if (
          fs.existsSync(path.join(candidate, 'Contents', 'Resources', 'icon.icns')) &&
          fs.existsSync(path.join(candidate, 'Contents', 'Resources', 'app.asar'))
        ) {
          return candidate;
        }
      } catch {}
    }
    return null;
  });
}

function readOfficialIconBackupMeta(options = {}) {
  const backupDir = getOfficialIconBackupDir(options);
  const icnsPath = path.join(backupDir, 'icon.icns');
  const pngPath = path.join(backupDir, 'icon.png');
  if (!fs.existsSync(icnsPath) || !fs.existsSync(pngPath)) return null;
  const metaRes = upgradeHelper.readJsonFileSafe(path.join(backupDir, 'meta.json'), {});
  const meta = metaRes.ok && metaRes.data && typeof metaRes.data === 'object' ? metaRes.data : {};
  const assetsCarPath = path.join(backupDir, 'Assets.car');
  return {
    backupDir,
    icnsPath,
    pngPath,
    assetsCarPath: fs.existsSync(assetsCarPath) ? assetsCarPath : null,
    icnsSha256: meta.icnsSha256 || sha256File(icnsPath),
    iconName: meta.iconName || null,
    antigravityVersion: meta.antigravityVersion || null,
    capturedAt: meta.capturedAt || null,
  };
}

function resolveOfficialIconSource(options = {}) {
  const localOfficial = findLocalOfficialApp(options);
  if (localOfficial) {
    return { kind: 'official-app', appPath: localOfficial };
  }

  const stateDir = resolveStateDir(options);
  try {
    const updaterPaths = builder.getUpdaterPaths({ stateDir });
    const cleanMeta = builder.readCleanBaseMeta(updaterPaths.cleanBaseDir);
    if (cleanMeta && cleanMeta.zipPath && fs.existsSync(cleanMeta.zipPath)) {
      return { kind: 'clean-base-zip', zipPath: cleanMeta.zipPath, version: cleanMeta.version || null };
    }
  } catch {}

  const backup = readOfficialIconBackupMeta({ stateDir });
  if (backup) {
    return { kind: 'icon-backup', ...backup };
  }

  return null;
}

/**
 * Snapshot the default official icon from the currently installed `哈基米.app` before
 * the user applies their first custom icon, so restore remains possible even if neither
 * `/Applications/Antigravity.app` nor `clean-base` zip exists later.
 */
function backupCurrentDefaultIconIfApplicable(targetAppPath, options = {}) {
  const stateDir = resolveStateDir(options);
  if (readOfficialIconBackupMeta({ stateDir })) {
    return { backedUp: false, reason: 'already_exists' };
  }
  const curIcns = path.join(targetAppPath, 'Contents', 'Resources', 'icon.icns');
  const curAsar = path.join(targetAppPath, 'Contents', 'Resources', 'app.asar');
  const curPlist = path.join(targetAppPath, 'Contents', 'Info.plist');
  const curAssetsCar = path.join(targetAppPath, 'Contents', 'Resources', 'Assets.car');
  if (!fs.existsSync(curIcns) || !fs.existsSync(curAsar)) {
    return { backedUp: false, reason: 'missing_resources' };
  }

  const localOfficial = findLocalOfficialApp(options);
  let looksDefault = false;
  if (localOfficial) {
    try {
      looksDefault = sha256File(curIcns) === sha256File(path.join(localOfficial, 'Contents', 'Resources', 'icon.icns'));
    } catch {}
  } else {
    const curIconName = readPlistIconName(curPlist, options);
    looksDefault = fs.existsSync(curAssetsCar) || Boolean(curIconName);
  }
  if (!looksDefault) {
    return { backedUp: false, reason: 'already_custom' };
  }

  try {
    const iconPngBuf = withNoAsar(() => builtinAsar.extractFile(curAsar, 'icon.png'));
    const backupDir = getOfficialIconBackupDir({ stateDir });
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(curIcns, path.join(backupDir, 'icon.icns'));
    fs.writeFileSync(path.join(backupDir, 'icon.png'), iconPngBuf);
    if (fs.existsSync(curAssetsCar)) {
      fs.copyFileSync(curAssetsCar, path.join(backupDir, 'Assets.car'));
    }
    const meta = {
      icnsSha256: sha256File(curIcns),
      iconName: readPlistIconName(curPlist, options),
      antigravityVersion: builder.readBundleShortVersion(curPlist) || null,
      capturedAt: new Date().toISOString(),
    };
    upgradeHelper.writeJsonFileAtomic(path.join(backupDir, 'meta.json'), meta, 0o600);
    return { backedUp: true, backupDir, meta };
  } catch (err) {
    return { backedUp: false, reason: err?.message || 'backup_failed' };
  }
}

function findFileRecursive(rootDir, targetRelSuffix) {
  return withNoAsar(() => {
    const normSuffix = targetRelSuffix.replace(/\\/g, '/');
    const queue = [rootDir];
    while (queue.length > 0) {
      const dir = queue.shift();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          queue.push(full);
        } else if (entry.isFile()) {
          const rel = path.relative(rootDir, full).replace(/\\/g, '/');
          if (rel === normSuffix || rel.endsWith(`/${normSuffix}`)) {
            return full;
          }
        }
      }
    }
    return null;
  });
}

function extractOfficialIconAssets(source, outDir, options = {}) {
  const execImpl = options.execFileSync || execFileSync;
  fs.mkdirSync(outDir, { recursive: true });
  const icnsOut = path.join(outDir, 'official.icns');
  const pngOut = path.join(outDir, 'official-512.png');
  const assetsOut = path.join(outDir, 'official-Assets.car');

  if (!source) {
    throw new Error('未找到官方默认图标来源（本地官方 Antigravity.app、底包缓存与图标备份均不可用）');
  }

  if (source.kind === 'official-app') {
    const appPath = source.appPath;
    fs.copyFileSync(path.join(appPath, 'Contents', 'Resources', 'icon.icns'), icnsOut);
    const pngBuf = withNoAsar(() =>
      builtinAsar.extractFile(path.join(appPath, 'Contents', 'Resources', 'app.asar'), 'icon.png')
    );
    fs.writeFileSync(pngOut, pngBuf);
    const srcAssets = path.join(appPath, 'Contents', 'Resources', 'Assets.car');
    let hasAssets = false;
    if (fs.existsSync(srcAssets)) {
      fs.copyFileSync(srcAssets, assetsOut);
      hasAssets = true;
    }
    const iconName = readPlistIconName(path.join(appPath, 'Contents', 'Info.plist'), options);
    return {
      icnsPath: icnsOut,
      pngPath: pngOut,
      assetsCarPath: hasAssets ? assetsOut : null,
      iconName,
      sourceKind: 'official-app',
    };
  }

  if (source.kind === 'clean-base-zip') {
    const unzipBin = resolveMacTool('/usr/bin/unzip', 'unzip');
    const tmpUnzip = path.join(outDir, 'unzip-official');
    fs.mkdirSync(tmpUnzip, { recursive: true });
    try {
      execImpl(
        unzipBin,
        [
          '-o',
          '-qq',
          source.zipPath,
          '*/Contents/Info.plist',
          '*/Contents/Resources/icon.icns',
          '*/Contents/Resources/app.asar',
          '-d',
          tmpUnzip,
        ],
        { stdio: 'pipe' }
      );
      // Assets.car is optional (introduced in Antigravity v2.34+); extract best-effort separately
      try {
        execImpl(unzipBin, ['-o', '-qq', source.zipPath, '*/Contents/Resources/Assets.car', '-d', tmpUnzip], {
          stdio: 'pipe',
        });
      } catch {}

      const foundIcns = findFileRecursive(tmpUnzip, 'Contents/Resources/icon.icns');
      const foundAsar = findFileRecursive(tmpUnzip, 'Contents/Resources/app.asar');
      const foundPlist = findFileRecursive(tmpUnzip, 'Contents/Info.plist');
      const foundAssets = findFileRecursive(tmpUnzip, 'Contents/Resources/Assets.car');
      if (!foundIcns || !foundAsar) {
        throw new Error('官方底包缓存中缺少 icon.icns 或 app.asar');
      }
      fs.copyFileSync(foundIcns, icnsOut);
      const pngBuf = withNoAsar(() => builtinAsar.extractFile(foundAsar, 'icon.png'));
      fs.writeFileSync(pngOut, pngBuf);
      let hasAssets = false;
      if (foundAssets && fs.existsSync(foundAssets)) {
        fs.copyFileSync(foundAssets, assetsOut);
        hasAssets = true;
      }
      const iconName = foundPlist ? readPlistIconName(foundPlist, options) : null;
      return {
        icnsPath: icnsOut,
        pngPath: pngOut,
        assetsCarPath: hasAssets ? assetsOut : null,
        iconName,
        sourceKind: 'clean-base-zip',
      };
    } finally {
      try {
        fs.rmSync(tmpUnzip, { recursive: true, force: true });
      } catch {}
    }
  }

  if (source.kind === 'icon-backup') {
    fs.copyFileSync(source.icnsPath, icnsOut);
    fs.copyFileSync(source.pngPath, pngOut);
    let hasAssets = false;
    if (source.assetsCarPath && fs.existsSync(source.assetsCarPath)) {
      fs.copyFileSync(source.assetsCarPath, assetsOut);
      hasAssets = true;
    }
    return {
      icnsPath: icnsOut,
      pngPath: pngOut,
      assetsCarPath: hasAssets ? assetsOut : null,
      iconName: source.iconName || null,
      sourceKind: 'icon-backup',
    };
  }

  throw new Error(`不支持的默认图标来源类型: ${source.kind}`);
}

function readCurrentIconDataUrl(targetAppPath) {
  const asarPath = path.join(targetAppPath, 'Contents', 'Resources', 'app.asar');
  try {
    const pngBuf = withNoAsar(() => {
      if (!fs.existsSync(asarPath)) return null;
      return builtinAsar.extractFile(asarPath, 'icon.png');
    });
    if (pngBuf && pngBuf.length > 0) {
      return `data:image/png;base64,${pngBuf.toString('base64')}`;
    }
  } catch {}
  return null;
}

function getIconStatus(options = {}) {
  const plat = options.platform || process.platform;
  if (plat !== 'darwin') {
    return {
      ok: true,
      supported: false,
      reason: '应用内换图标目前仅支持 macOS 哈基米.app',
    };
  }

  let targetAppPath;
  try {
    targetAppPath = resolveCurrentBundlePath(options);
  } catch (err) {
    return { ok: false, supported: true, error: err?.message || '无法定位目标应用路径' };
  }

  const stateDir = resolveStateDir(options);
  const curIcns = path.join(targetAppPath, 'Contents', 'Resources', 'icon.icns');
  const curPlist = path.join(targetAppPath, 'Contents', 'Info.plist');
  const curAssetsCar = path.join(targetAppPath, 'Contents', 'Resources', 'Assets.car');
  const exists = fs.existsSync(targetAppPath) && fs.existsSync(curIcns);

  const localOfficial = findLocalOfficialApp(options);
  const backup = readOfficialIconBackupMeta({ stateDir });
  const officialSource = resolveOfficialIconSource({ ...options, stateDir });

  let isCustomIcon = null;
  if (exists) {
    if (localOfficial) {
      try {
        const offIcns = path.join(localOfficial, 'Contents', 'Resources', 'icon.icns');
        isCustomIcon = sha256File(curIcns) !== sha256File(offIcns);
      } catch {}
    } else if (backup && backup.icnsSha256) {
      try {
        isCustomIcon = sha256File(curIcns) !== backup.icnsSha256;
      } catch {}
    } else {
      const hasAssetsCar = fs.existsSync(curAssetsCar);
      const hasIconName = Boolean(readPlistIconName(curPlist, options));
      if (hasAssetsCar || hasIconName) {
        isCustomIcon = false;
      } else {
        // Without local official app or backup on pre-v2.34, absence of Assets.car/CFBundleIconName
        // strongly implies custom icon on modern builds (v2.34+).
        const ver = builder.readBundleShortVersion(curPlist);
        if (ver) {
          const parts = ver.split('.').map((n) => Number(n));
          if (parts[0] > 2 || (parts[0] === 2 && parts[1] >= 34)) {
            isCustomIcon = true;
          }
        }
      }
    }
  }

  const resPath = getIconResultPath({ stateDir });
  const lastResRead = upgradeHelper.readJsonFileSafe(resPath, null);
  const lastResult = lastResRead.ok && lastResRead.data ? lastResRead.data : null;
  if (lastResult && options.consumeLastResult === true) {
    upgradeHelper.unlinkIfExists(resPath);
  }

  return {
    ok: true,
    supported: true,
    targetAppPath,
    exists,
    isCustomIcon,
    canRestoreDefault: Boolean(officialSource),
    restoreSourceKind: officialSource?.kind || null,
    currentIconDataUrl: exists ? readCurrentIconDataUrl(targetAppPath) : null,
    lastResult,
    busy: coldIconSwapInFlight,
  };
}

/**
 * Clone the running 哈基米.app into an isolated staging directory (APFS CoW),
 * replace icon assets + app.asar/icon.png + Info.plist integrity, refresh main
 * executable inode, ad-hoc sign, and strictly verify signatures BEFORE touching
 * the live bundle.
 */
function stageIconSwapBundle(spec = {}, options = {}) {
  const execImpl = options.execFileSync || execFileSync;
  const mode = spec.mode === 'restore' ? 'restore' : 'custom';
  const targetAppPath = path.resolve(String(spec.targetAppPath || ''));
  const stageDir = path.resolve(String(spec.stageDir || ''));
  const stateDir = resolveStateDir({ stateDir: spec.stateDir || options.stateDir });

  if (!options.allowOfficialForTest) {
    assertNotOfficialAntigravityApp(targetAppPath, '克隆应用图标源');
    assertNotOfficialAntigravityApp(stageDir, '创建图标沙盒目录');
  }
  const stageAppPath = path.join(stageDir, path.basename(targetAppPath) || '哈基米.app');
  if (!options.allowOfficialForTest) {
    assertNotOfficialAntigravityApp(stageAppPath, '构建图标沙盒应用');
  }

  let currentStage = 'preflight';
  try {
    if (!targetAppPath || !fs.existsSync(targetAppPath)) {
      throw new Error(`找不到已安装的应用: ${targetAppPath}`);
    }
    const targetPlist = path.join(targetAppPath, 'Contents', 'Info.plist');
    const targetAsar = path.join(targetAppPath, 'Contents', 'Resources', 'app.asar');
    const targetMainExec = path.join(targetAppPath, 'Contents', 'MacOS', 'Antigravity');
    if (!fs.existsSync(targetPlist) || !fs.existsSync(targetAsar) || !fs.existsSync(targetMainExec)) {
      throw new Error(`目标应用结构不完整: ${targetAppPath}`);
    }

    if (fs.existsSync(stageDir)) {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
    fs.mkdirSync(stageDir, { recursive: true });

    const preparedDir = path.join(stageDir, '_icon_assets');
    fs.mkdirSync(preparedDir, { recursive: true });

    let preparedIcns;
    let preparedPng;
    let restoreAssetsCar = null;
    let restoreIconName = null;
    let masked = false;
    let restoreSourceKind = null;

    if (mode === 'custom') {
      currentStage = 'backup-default';
      try {
        backupCurrentDefaultIconIfApplicable(targetAppPath, {
          stateDir,
          officialAppPath: spec.officialAppPath || options.officialAppPath,
          skipDefaultOfficialLookup: options.skipDefaultOfficialLookup,
          execFileSync: execImpl,
          useXmlFallback: options.useXmlFallback,
        });
      } catch {}

      currentStage = 'convert-icon';
      preparedIcns = path.join(preparedDir, 'custom.icns');
      preparedPng = path.join(preparedDir, 'custom-512.png');
      const convRes = buildMacosIcon({
        inputPath: spec.inputPath,
        outIcnsPath: preparedIcns,
        outPngPath: preparedPng,
        rawIcon: Boolean(spec.rawIcon),
        execFileSync: execImpl,
      });
      masked = Boolean(convRes.masked);
    } else {
      currentStage = 'locate-official-icon';
      const source = resolveOfficialIconSource({
        stateDir,
        officialAppPath: spec.officialAppPath || options.officialAppPath,
        skipDefaultOfficialLookup: options.skipDefaultOfficialLookup,
      });
      const extracted = extractOfficialIconAssets(source, preparedDir, {
        execFileSync: execImpl,
        useXmlFallback: options.useXmlFallback,
      });
      preparedIcns = extracted.icnsPath;
      preparedPng = extracted.pngPath;
      restoreAssetsCar = extracted.assetsCarPath;
      restoreIconName = extracted.iconName;
      restoreSourceKind = extracted.sourceKind;
    }

    // APFS Copy-on-Write clone: near-instant, zero extra disk for untouched files like 205MB language_server
    currentStage = 'clone-bundle';
    builder.cloneAppBundle(targetAppPath, stageAppPath, execImpl);

    const stageResDir = path.join(stageAppPath, 'Contents', 'Resources');
    const stageIcns = path.join(stageResDir, 'icon.icns');
    const stageAssetsCar = path.join(stageResDir, 'Assets.car');
    const stageAsar = path.join(stageResDir, 'app.asar');
    const stagePlist = path.join(stageAppPath, 'Contents', 'Info.plist');
    const stageMainExec = path.join(stageAppPath, 'Contents', 'MacOS', 'Antigravity');
    const stageLs = path.join(stageResDir, 'bin', 'language_server');

    currentStage = 'entitlements';
    const entAppPath = path.join(stageDir, 'app.entitlements');
    if (options.skipCodesign !== true && process.platform === 'darwin') {
      const entXml = builder.extractEntitlements(
        targetAppPath,
        '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict/></plist>',
        execImpl
      );
      fs.writeFileSync(entAppPath, entXml, 'utf8');
    }

    currentStage = 'replace-resources';
    fs.copyFileSync(preparedIcns, stageIcns);
    if (mode === 'restore' && restoreAssetsCar && fs.existsSync(restoreAssetsCar)) {
      fs.copyFileSync(restoreAssetsCar, stageAssetsCar);
    } else {
      upgradeHelper.unlinkIfExists(stageAssetsCar);
    }

    currentStage = 'replace-asar';
    const asarRes = replaceAsarIcon({
      asarPath: stageAsar,
      iconPng: preparedPng,
    });
    if (!asarRes || !asarRes.ok || !asarRes.sha256) {
      throw new Error('更新 app.asar 内置图标失败');
    }

    currentStage = 'info-plist';
    updateInfoPlistForIcon(
      stagePlist,
      asarRes.sha256,
      { mode, restoreIconName },
      { execFileSync: execImpl, useXmlFallback: options.useXmlFallback }
    );

    currentStage = 'codesign';
    const tmpInode = `${stageMainExec}.tmp_inode`;
    fs.copyFileSync(stageMainExec, tmpInode);
    fs.chmodSync(tmpInode, fs.statSync(stageMainExec).mode);
    fs.renameSync(tmpInode, stageMainExec);

    if (options.skipCodesign !== true && process.platform === 'darwin') {
      const codesignBin = resolveMacTool('/usr/bin/codesign', 'codesign');
      // Outer bundle MUST NOT use --options runtime so Library Validation allows Google-signed Electron Framework
      execImpl(codesignBin, ['--force', '--sign', '-', '--entitlements', entAppPath, stageAppPath], {
        stdio: 'pipe',
      });
      currentStage = 'verify';
      if (fs.existsSync(stageLs)) {
        execImpl(codesignBin, ['--verify', '--strict', stageLs], { stdio: 'pipe' });
      }
      execImpl(codesignBin, ['--verify', '--strict', stageAppPath], { stdio: 'pipe' });
    }

    // Clean ephemeral helper files inside stageDir, keeping only staged `.app`
    upgradeHelper.unlinkIfExists(entAppPath);
    try {
      fs.rmSync(preparedDir, { recursive: true, force: true });
    } catch {}

    return {
      ok: true,
      mode,
      stageDir,
      stagedAppPath: stageAppPath,
      asarSha256: asarRes.sha256,
      masked,
      restoreSourceKind,
    };
  } catch (err) {
    try {
      if (fs.existsSync(stageDir)) {
        if (!options.allowOfficialForTest) {
          assertNotOfficialAntigravityApp(stageDir, '清理失败图标沙盒');
        }
        fs.rmSync(stageDir, { recursive: true, force: true });
      }
    } catch {}
    return {
      ok: false,
      failedStage: currentStage,
      error: err?.message || String(err),
    };
  }
}

function runIconWorkerAction(action, spec, options = {}) {
  if (typeof options.workerImpl === 'function') {
    return Promise.resolve(options.workerImpl(action, spec, options));
  }
  const workerScript = path.join(__dirname, 'hakimi-icon-manager.js');
  const stateDir = resolveStateDir(options);
  const scratchDir = path.join(upgradeHelper.getRuntimeDir({ stateDir }), 'icon-rpc');
  fs.mkdirSync(scratchDir, { recursive: true, mode: 0o700 });

  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 6)}`;
  const specPath = path.join(scratchDir, `icon-${action}-spec-${suffix}.json`);
  const resultPath = path.join(scratchDir, `icon-${action}-res-${suffix}.json`);
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), { encoding: 'utf8', mode: 0o600 });

  const runtime = resolveWorkerRuntime(options);
  const spawnImpl = options.spawnImpl || spawn;
  const timeoutMs = options.workerTimeoutMs || (action === 'preview' ? 45000 : 120000);

  return new Promise((resolve) => {
    let stderr = '';
    const child = spawnImpl(
      runtime.bin,
      [workerScript, action, '--spec', specPath, '--result-out', resultPath],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...runtime.envExtra },
      }
    );

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk || '').slice(0, 2000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      upgradeHelper.unlinkIfExists(specPath);
      upgradeHelper.unlinkIfExists(resultPath);
      resolve({ ok: false, failedStage: 'worker-spawn', error: err?.message || String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed = null;
      try {
        if (fs.existsSync(resultPath)) {
          parsed = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        }
      } catch {}
      upgradeHelper.unlinkIfExists(specPath);
      upgradeHelper.unlinkIfExists(resultPath);
      if (parsed && typeof parsed === 'object') {
        resolve(parsed);
      } else {
        resolve({
          ok: false,
          failedStage: 'worker-exit',
          error: (stderr || '').trim() || `图标处理子进程异常退出 (code=${code})`,
        });
      }
    });
  });
}

async function previewCustomIcon(payload = {}, options = {}) {
  const plat = options.platform || process.platform;
  if (plat !== 'darwin') {
    return { ok: false, supported: false, error: '应用内换图标目前仅支持 macOS 哈基米.app' };
  }
  const inputPath = payload?.inputPath ? String(payload.inputPath).trim() : '';
  if (!inputPath) {
    return { ok: false, supported: true, error: '请先选择一张图片文件' };
  }
  try {
    const res = await runIconWorkerAction(
      'preview',
      {
        inputPath,
        rawIcon: Boolean(payload.rawIcon),
        previewSize: Number(payload.previewSize) || 256,
      },
      options
    );
    return { supported: true, ...res };
  } catch (err) {
    return { ok: false, supported: true, error: err?.message || '生成图标预览失败' };
  }
}

async function pickIconFileDialog(targetWin = null, options = {}) {
  const plat = options.platform || process.platform;
  if (plat !== 'darwin') {
    return { ok: false, supported: false, error: '应用内换图标目前仅支持 macOS 哈基米.app' };
  }
  const electron = options.electronOverride || resolveElectron();
  if (!electron?.dialog || typeof electron.dialog.showOpenDialog !== 'function') {
    return { ok: false, supported: false, error: '当前宿主不支持系统文件选择器' };
  }
  const dialogOpts = {
    title: '选择应用图标图片',
    buttonLabel: '选择图标',
    properties: ['openFile'],
    filters: [
      { name: '图标与图片', extensions: SUPPORTED_ICON_EXTENSIONS },
    ],
  };
  const result =
    targetWin && !targetWin.isDestroyed?.()
      ? await electron.dialog.showOpenDialog(targetWin, dialogOpts)
      : await electron.dialog.showOpenDialog(dialogOpts);
  if (!result || result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) {
    return { ok: true, supported: true, canceled: true, filePath: null };
  }
  return { ok: true, supported: true, canceled: false, filePath: result.filePaths[0] };
}

async function executeInAppIconSwap(mode, payload = {}, options = {}) {
  const plat = options.platform || process.platform;
  if (plat !== 'darwin') {
    return { ok: false, supported: false, error: '应用内换图标目前仅支持 macOS 哈基米.app' };
  }
  if (coldIconSwapInFlight) {
    return { ok: false, supported: true, error: '正在应用图标并重启，请稍候…' };
  }

  let targetAppPath;
  try {
    targetAppPath = resolveCurrentBundlePath(options);
  } catch (err) {
    return { ok: false, supported: true, error: err?.message || '无法定位目标应用路径' };
  }

  if (mode === 'custom') {
    const inputPath = payload?.inputPath ? String(payload.inputPath).trim() : '';
    if (!inputPath) {
      return { ok: false, supported: true, error: '请先选择一张本地图片' };
    }
  }

  const stateDir = resolveStateDir(options);
  const updaterPaths = builder.getUpdaterPaths({ stateDir });
  const stageDir = path.join(updaterPaths.tmpDir, `icon-stage-${Date.now()}-${process.pid}`);

  const stageRes = await runIconWorkerAction(
    'stage-swap',
    {
      mode,
      inputPath: mode === 'custom' ? String(payload.inputPath) : '',
      rawIcon: Boolean(payload?.rawIcon),
      targetAppPath,
      stageDir,
      stateDir,
      officialAppPath: options.officialAppPath || '',
    },
    options
  );

  if (!stageRes || !stageRes.ok || !stageRes.stagedAppPath) {
    return {
      ok: false,
      supported: true,
      failedStage: stageRes?.failedStage || 'stage-swap',
      error: stageRes?.error || '沙盒图标替换失败',
    };
  }

  try {
    upgradeHelper.verifyStagedBundleReady(stageRes.stagedAppPath);
  } catch (err) {
    try {
      if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
    } catch {}
    return { ok: false, supported: true, failedStage: 'verify', error: err?.message || '沙盒校验失败' };
  }

  const runtimeDir = upgradeHelper.getRuntimeDir({ stateDir });
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

  const helperSrcPath = path.join(__dirname, 'hakimi-upgrade-helper.js');
  const stagedHelperPath = path.join(runtimeDir, upgradeHelper.UPGRADE_HELPER_FILE_NAME);
  fs.writeFileSync(stagedHelperPath, fs.readFileSync(helperSrcPath, 'utf8'), { encoding: 'utf8', mode: 0o700 });

  const homeDir = options.homeDir ? path.resolve(String(options.homeDir)) : os.homedir();
  const userDataDir = options.userDataDir
    ? path.resolve(String(options.userDataDir))
    : upgradeHelper.getDefaultUserDataDir(process.platform, process.env, homeDir);

  const job = {
    jobKind: 'icon',
    iconMode: mode,
    targetAppPath,
    stagedAppPath: stageRes.stagedAppPath,
    stagingRootDir: stageDir,
    resultPath: getIconResultPath({ stateDir }),
    stateDir,
    userDataDir,
    homeDir,
    parentPid: process.pid,
    createdAt: new Date().toISOString(),
  };

  const jobFilePath = path.join(runtimeDir, `hakimi-icon-job-${Date.now()}-${process.pid}.json`);
  const writeJob = upgradeHelper.writeJsonFileAtomic(jobFilePath, job, 0o600);
  if (!writeJob.ok) {
    return { ok: false, supported: true, error: writeJob.error || '写入图标冷替换任务失败' };
  }

  const runtime = resolveWorkerRuntime(options);
  const spawnImpl = options.spawnImpl || spawn;
  const logPath = path.join(runtimeDir, upgradeHelper.UPGRADE_LOG_FILE_NAME);
  let logFd = 'ignore';
  try {
    logFd = fs.openSync(logPath, 'a', 0o600);
  } catch {
    logFd = 'ignore';
  }

  try {
    const child = spawnImpl(runtime.bin, [stagedHelperPath, '--job', jobFilePath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, ...runtime.envExtra },
    });
    if (child && typeof child.unref === 'function') child.unref();

    coldIconSwapInFlight = true;

    if (options.quitAfterHandoff !== false) {
      const delayMs = Number.isFinite(options.quitDelayMs) ? options.quitDelayMs : 120;
      const doQuit = () => {
        try {
          const meterMain = require('./meter-main');
          meterMain.setAppQuitting(true);
        } catch {}
        try {
          const collector = require('./meter-collector');
          collector.flushPricingLedger();
        } catch {}
        const electron = options.electronOverride || resolveElectron();
        if (electron?.app && typeof electron.app.quit === 'function') {
          electron.app.quit();
        }
      };
      if (delayMs <= 0) doQuit();
      else setTimeout(doQuit, delayMs);
    }

    return {
      ok: true,
      supported: true,
      coldSwapping: true,
      mode,
      helperPid: child?.pid || null,
      targetAppPath,
      asarSha256: stageRes.asarSha256,
      masked: Boolean(stageRes.masked),
    };
  } catch (err) {
    return { ok: false, supported: true, error: err?.message || '启动图标冷替换进程失败' };
  } finally {
    if (typeof logFd === 'number') {
      try { fs.closeSync(logFd); } catch {}
    }
  }
}

function applyCustomIcon(payload = {}, options = {}) {
  return executeInAppIconSwap('custom', payload, options);
}

function restoreDefaultIcon(payload = {}, options = {}) {
  return executeInAppIconSwap('restore', payload, options);
}

function resetInFlightFlagForTest() {
  coldIconSwapInFlight = false;
}

function runCli(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const getArg = (flag) => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : null;
  };
  const specPath = getArg('--spec');
  const resultOut = getArg('--result-out');

  const emitResult = (res) => {
    if (resultOut) {
      fs.mkdirSync(path.dirname(path.resolve(resultOut)), { recursive: true });
      fs.writeFileSync(path.resolve(resultOut), JSON.stringify(res, null, 2), 'utf8');
    } else {
      process.stdout.write(`${JSON.stringify(res)}\n`);
    }
    if (!res || res.ok === false) process.exitCode = 1;
  };

  if (cmd === 'preview') {
    if (!specPath) throw new Error('Missing --spec');
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    try {
      emitResult(renderIconPreview(spec));
    } catch (err) {
      emitResult({ ok: false, error: err?.message || String(err) });
    }
    return;
  }

  if (cmd === 'stage-swap') {
    if (!specPath) throw new Error('Missing --spec');
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    emitResult(stageIconSwapBundle(spec));
    return;
  }

  throw new Error(`Unknown command: ${cmd || '(none)'}`);
}

if (require.main === module) {
  try {
    runCli();
  } catch (err) {
    process.stderr.write(`${err?.message || String(err)}\n`);
    process.exit(1);
  }
}

module.exports = {
  SUPPORTED_ICON_EXTENSIONS,
  ICON_RESULT_FILE_NAME,
  OFFICIAL_ICON_BACKUP_DIR_NAME,
  ICONSET_SPECS,
  resolveCurrentBundlePath,
  resolveWorkerRuntime,
  getIconResultPath,
  getOfficialIconBackupDir,
  buildMacosIcon,
  renderIconPreview,
  replaceAsarIcon,
  readPlistIconName,
  updateInfoPlistForIcon,
  findLocalOfficialApp,
  readOfficialIconBackupMeta,
  resolveOfficialIconSource,
  backupCurrentDefaultIconIfApplicable,
  extractOfficialIconAssets,
  readCurrentIconDataUrl,
  getIconStatus,
  stageIconSwapBundle,
  pickIconFileDialog,
  previewCustomIcon,
  applyCustomIcon,
  restoreDefaultIcon,
  resetInFlightFlagForTest,
};
