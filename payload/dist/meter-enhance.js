'use strict';
/**
 * 哈基米.app 后台语言服务进程检测与重启辅助模块 (meter-enhance.js)
 * 严格只操作 哈基米.app 副本的 language_server，绝不修改 /Applications/Antigravity.app。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  getHakimiAppPath,
  assertNotOfficialAntigravityApp,
  isOfficialAntigravityPath,
} = require('./asar-engine');

function resolveTargetBinaries(options = {}) {
  if (Array.isArray(options.targets)) {
    return options.targets.map((t, idx) => {
      const targetPath = path.resolve(String(t.path || t));
      assertNotOfficialAntigravityApp(targetPath, 'target language_server binary');
      return {
        id: t.id || (idx === 0 ? 'desktop' : 'custom'),
        label: t.label || path.basename(targetPath),
        path: targetPath,
      };
    });
  }

  const hakimiApp = options.appPath ? path.resolve(options.appPath) : getHakimiAppPath();
  assertNotOfficialAntigravityApp(hakimiApp, 'target app bundle');

  const binDir = path.join(hakimiApp, 'Contents', 'Resources', 'bin');
  const primary = path.join(binDir, 'language_server');
  const alt = path.join(binDir, 'language_server_macos_arm');

  if (fs.existsSync(alt) && !fs.existsSync(primary)) {
    return [{ id: 'desktop', label: '哈基米.app 后端 (language_server_macos_arm)', path: alt }];
  }
  return [{ id: 'desktop', label: '哈基米.app 后端 (language_server)', path: primary }];
}

function parseMacPsOutput(psOut, targetPath) {
  const hits = [];
  if (!psOut || !targetPath) return hits;
  let normTarget = path.resolve(targetPath);
  try {
    if (fs.existsSync(targetPath)) normTarget = fs.realpathSync(targetPath);
  } catch {}
  const targetCandidates = new Set([path.resolve(targetPath), normTarget]);

  for (const line of String(psOut).split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const startedAtMs = Date.parse(m[2]);
    const cmd = m[3].trim();
    for (const tp of targetCandidates) {
      if (cmd === tp || cmd.startsWith(tp + ' ')) {
        hits.push({
          pid,
          startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
          command: cmd,
        });
        break;
      }
    }
  }
  return hits;
}

function findMatchingLanguageServerPids(targetPaths) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return [];
  const normTargets = new Set(
    (Array.isArray(targetPaths) ? targetPaths : [])
      .filter((p) => p && !isOfficialAntigravityPath(p))
      .map((p) => {
        try {
          return fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p);
        } catch {
          return path.resolve(p);
        }
      })
  );
  if (normTargets.size === 0) return [];

  try {
    const out = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 2500,
      env: { ...process.env, LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8', LC_TIME: 'C' },
    });
    const hits = [];
    for (const line of String(out || '').split(/\r?\n/)) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const cmd = m[2].trim();
      for (const tp of normTargets) {
        if (cmd === tp || cmd.startsWith(tp + ' ')) {
          hits.push({ pid, target: tp });
          break;
        }
      }
    }
    return hits;
  } catch {
    return [];
  }
}

function checkLanguageServerRunning(options = {}) {
  try {
    const targets = resolveTargetBinaries(options).map((t) => t.path);
    return findMatchingLanguageServerPids(targets).length > 0;
  } catch {
    return false;
  }
}

function restartLanguageServers(options = {}) {
  if (process.platform !== 'darwin') {
    return { ok: false, killed: [], error: '仅支持 macOS 平台重启 哈基米.app 后台语言服务' };
  }
  const targets = resolveTargetBinaries(options).map((t) => t.path);
  const hits = findMatchingLanguageServerPids(targets);
  const killed = [];
  for (const h of hits) {
    try {
      process.kill(h.pid, 'SIGTERM');
      killed.push(`${path.basename(h.target)} (PID ${h.pid})`);
    } catch {}
  }
  return { ok: true, killed };
}

module.exports = {
  resolveTargetBinaries,
  parseMacPsOutput,
  findMatchingLanguageServerPids,
  checkLanguageServerRunning,
  restartLanguageServers,
};
