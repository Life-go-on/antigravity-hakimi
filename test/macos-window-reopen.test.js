'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const filename = path.join(__dirname, '../payload/dist/meter-main.js');
const source = fs.readFileSync(filename, 'utf8');

function setup(platform = 'darwin') {
  const app = new EventEmitter();
  const hubWindows = [];
  const getHubWindows = () => hubWindows.filter(win => !win.isDestroyed());
  const utils = {
    getHubWindows,
    getLocalHubWindows: () => getHubWindows().filter(win => win.kind === 'local'),
  };
  let hostCreates = 0;
  // The host registers its own activate listener and only creates when there are no hubs.
  app.on('activate', () => { if (!getHubWindows().length) hostCreates++; });
  const exports = {};
  const modules = {
    electron: { app },
    fs: { existsSync: () => true, readFileSync: () => '{"runInBackground":true}' },
    os: { homedir: () => '/unused' },
    path,
    './meter-collector': { flushPricingLedger() {} },
    './meter-core': {},
    './meter-ssh': {
      getRemoteBackendForWindow: win => win.kind === 'remote' ? {} : null,
    },
    './utils': utils,
  };
  vm.runInNewContext(source, {
    exports,
    process: { platform, env: {} },
    require: id => {
      assert.ok(Object.hasOwn(modules, id), `Unexpected module: ${id}`);
      return modules[id];
    },
    setTimeout() {}, clearTimeout() {}, setImmediate() {},
  }, { filename });

  function window(kind = 'local', initiallyVisible = true) {
    const win = new EventEmitter();
    let visible = initiallyVisible;
    let destroyed = false;
    Object.assign(win, {
      kind,
      webContents: new EventEmitter(),
      session: {},
      showCalls: 0,
      focusCalls: 0,
      isDestroyed: () => destroyed,
      isVisible: () => visible && !destroyed,
      hide() { visible = false; this.emit('hide'); },
      show() { this.showCalls++; visible = true; this.emit('show'); },
      focus() { this.focusCalls++; this.emit('focus'); },
      destroy() { destroyed = true; this.emit('closed'); },
      close() {
        let prevented = false;
        this.emit('close', { preventDefault: () => { prevented = true; } });
        if (!prevented) this.destroy();
        return prevented;
      },
    });
    // Include an unclassified top-level dialog in the broad host list, not the local list.
    if (kind !== 'auxiliary') hubWindows.push(win);
    app.emit('base-window-created', {}, win);
    return win;
  }

  return { app, window, activate: () => app.emit('activate', {}, false), hostCreates: () => hostCreates };
}

test('macOS activate restores and focuses the exact window hidden by the close hook only once', () => {
  const ctx = setup();
  const win = ctx.window();
  const session = win.session;
  assert.equal(win.close(), true);
  assert.equal(win.isDestroyed(), false);
  assert.equal(win.isVisible(), false);

  ctx.activate();
  ctx.activate();
  assert.equal(win.isVisible(), true);
  assert.equal(win.showCalls, 1);
  assert.equal(win.focusCalls, 1);
  assert.equal(win.session, session);
  assert.equal(ctx.hostCreates(), 0);

  assert.equal(win.close(), true);
  ctx.activate();
  assert.equal(win.showCalls, 2);
});

test('a visible local window takes precedence over a window hidden by the close hook', () => {
  const ctx = setup();
  const hidden = ctx.window();
  assert.equal(hidden.close(), true);
  const visible = ctx.window();
  ctx.activate();
  assert.equal(hidden.showCalls, 0);
  assert.equal(visible.focusCalls, 0);

  visible.destroy();
  ctx.activate();
  assert.equal(hidden.showCalls, 1);
});

test('only the close-hook marker allows reopen, not unrelated hidden or non-local windows', () => {
  const ctx = setup();
  const local = ctx.window();
  const unrelated = ctx.window('local', false);
  assert.equal(local.close(), true);
  const remote = ctx.window('remote', false);
  const auxiliary = ctx.window('auxiliary', true);
  const dialog = ctx.window('dialog', true);
  ctx.activate();
  assert.equal(local.showCalls, 1);
  assert.equal(local.focusCalls, 1);
  assert.deepEqual([unrelated, remote, auxiliary, dialog].map(win => win.showCalls), [0, 0, 0, 0]);

  local.destroy();
  assert.equal(remote.close(), false);
  assert.equal(auxiliary.close(), false);
  assert.equal(dialog.close(), false);
});

test('showing a tracked window through another action clears the marker', () => {
  const ctx = setup();
  const win = ctx.window();
  assert.equal(win.close(), true);
  win.show();
  win.hide();
  ctx.activate();
  assert.equal(win.showCalls, 1);
  assert.equal(win.focusCalls, 0);
});

test('destroyed windows are not restored and the host still creates on empty', () => {
  const ctx = setup();
  const win = ctx.window();
  assert.equal(win.close(), true);
  win.destroy();
  ctx.activate();
  assert.equal(win.showCalls, 0);
  assert.equal(ctx.hostCreates(), 1);
});

test('before-quit suppresses both restoring a hidden window and intercepting a close', () => {
  const ctx = setup();
  const hidden = ctx.window();
  assert.equal(hidden.close(), true);
  ctx.app.emit('before-quit');
  ctx.activate();
  assert.equal(hidden.showCalls, 0);
  assert.equal(hidden.close(), false);
});

for (const platform of ['win32', 'linux']) {
  test(`${platform} retains background close behavior without macOS activate recovery`, () => {
    const ctx = setup(platform);
    const win = ctx.window();
    assert.equal(win.close(), true);
    ctx.activate();
    assert.equal(win.isVisible(), false);
    assert.equal(win.showCalls, 0);
    assert.equal(win.focusCalls, 0);
  });
}
