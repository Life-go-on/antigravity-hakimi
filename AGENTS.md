# AGENTS.md — `antigravity-hakimi` (`哈基米.app`)

面向在本仓库工作的 AI Agent 与开发者的约束与工程指南。

---

## 1. 项目概述

- **运行环境**：macOS Apple Silicon (`arm64`)，Node.js `>=22.4.0`（`agy` CLI 地区解锁同时支持 Linux `x86-64` / `arm64`）。
- **核心机制**：默认从官方更新源拉取/复用单槽位缓存最新 Antigravity（或通过 `--local` / `--from` 读取本地只读 `/Applications/Antigravity.app` / `.orig`），构建独立增强版桌面客户端 `/Applications/哈基米.app`。
- **身份复用**：保留内部 `CFBundleIdentifier` (`com.google.antigravity`) 与主可执行文件名 `Antigravity`，以与官方客户端共享 Google 登录态、历史会话及用户数据目录，同时严格隔离应用二进制本身。

---

## 2. 硬性安全与工程红线（不可违背）

1. **严禁修改官方原版应用**
   - 任何时候都**不得**写入、修补、替换、关闭或重签名 `/Applications/Antigravity.app`、`/Applications/Antigravity.app.orig` 或指向它们的符号链接。
   - 所有写入/删除/签名/冷重启目标路径必须通过 `payload/dist/asar-engine.js` 中的 `assertNotOfficialAntigravityApp()`（以及 `meter-account-cold-helper.js`、`hakimi-upgrade-helper.js` 中的 `isOfficialAntigravityBundle()`）守卫。
2. **禁止在 Agent 会话内自动杀掉或重启运行中的 `哈基米.app`**
   - 若 Agent 正运行在 `/Applications/哈基米.app` 内，**禁止**主动执行裸命令 `bash ./build-hakimi.sh`（默认会覆盖并自动重启运行中的 `哈基米.app`）、`set-hakimi-icon.sh --restart`，或手工 `kill`/`pkill` `哈基米.app` / `language_server`（会导致当前宿主进程与对话直接中断）；仅在用户明确要求立刻重启时例外。
   - 会话内验证优先使用 `npm test`、`npm run doctor`，或 `bash ./build-hakimi.sh --stage-only`（默认同正式版走官方最新且只读复用缓存；离线可加 `--local`，仅在 `/tmp` 构建并校验签名，不动 `/Applications` 与用户配置目录）。
3. **禁止直接手改渲染层编译产物**
   - `payload/dist/meter-renderer.js` 是由 `src/renderer/*` 编译生成的单文件产物。所有 UI / 前端逻辑修改必须改在 `src/renderer/` 下，并运行 `npm run build:renderer`（`npm test` 的 `pretest` 钩子也会自动执行）。
4. **禁止重新引入已裁剪功能符号（`EXCLUDED_SYMBOLS`）**
   - `test/asar-and-pruning.test.js` 会扫描 `payload/dist/*.js` 与 `src/renderer/*` 的全文（包括注释）。**绝对不要**重新引入任何已在 `EXCLUDED_SYMBOLS` 中列出的标识符（范围覆盖：免 TUN 代理、一键开 CLI 按钮、旧版上游 GitHub 更新器符号、提示词精简档位、自动中文会话/章节标题提示词补丁、API 参考计价/汇率/订阅费用统计，以及上下文窗口二进制补丁与外发请求拦截相关符号；哈基米双源自动升级器须统一使用独立的 `hakimi-upgrade` 命名空间）。
5. **严禁修改提示词或注入任何外发请求拦截钩子**
   - 任何与官方默认不一致的 Prompt（主 Agent System Prompt、子代理提示词、工具定义、标题生成提示词）以及对发往后端请求载荷的拦截改写均存在高账号风控风险。
   - **绝对禁止**在 `language_server`、`agy` CLI 二进制、`app.asar` 主进程/预加载脚本或渲染层中修改提示词字符串，或挂接 `fetch` / `WebSocket` / `XMLHttpRequest` / `__JETSKI_LS_CLIENT_DECORATOR__` 外发请求拦截器（`test/asar-and-pruning.test.js` 对此有强制单测校验）。
   - 桌面端汉化运行时（`payload/dist/i18n/i18n-runtime.js`）必须严格限定于本地 Electron DOM 界面渲染。

---

## 3. 常用开发、构建与诊断命令

```bash
# 编译渲染层 src/renderer/* -> payload/dist/meter-renderer.js
npm run build:renderer

# 自动重新编译渲染层并运行全部单元测试
npm test

# 只读健康诊断（官方包隔离、版本同步、ASAR 摘要、codesign、补丁、进程与 agy CLI）
npm run doctor
# 支持参数：node scripts/doctor.js --json --allow-missing

# 安全沙盒构建验证（仅在 /tmp 目录构建并执行 codesign --verify --strict，不改 /Applications 与用户目录）
bash ./build-hakimi.sh --stage-only
bash ./build-hakimi.sh --stage-only --local

# 构建并安装到 /Applications/哈基米.app（由用户在独立终端按需执行）
# 默认一步到位：拉取/复用官方最新 + 覆盖安装 + 解锁本机 agy CLI + 自动打开/重启
bash ./build-hakimi.sh
bash ./build-hakimi.sh --local --no-restart

# 仅对已构建的 哈基米.app 秒级更换图标或还原默认图标
bash ./set-hakimi-icon.sh <img_path|--restore> [--raw-icon] [--restart]

# 单独对本机 agy CLI 执行地区解锁
npm run unlock:cli
```

---

## 4. 仓库结构与核心模块

- `build-hakimi.sh`：主构建脚本（默认拉取/复用官方最新签名版并共享单槽位 `clean-base` 缓存、断网回退本机源、可选图标处理、`language_server` 地区解锁、ASAR 重打包、`Contents/Resources/hakimi-build-meta.json` 写入、`ElectronAsarIntegrity` 同步、inode 刷新、`codesign` 签名、默认覆盖与自动重启/打开及 best-effort CLI 解锁；支持 `--stage-only` / `--local` / `--no-restart` / `--no-cli` / `--no-overwrite` 并兼容旧参数）。
- `set-hakimi-icon.sh`：针对已存在 `/Applications/哈基米.app` 原位替换 `Contents/Resources/icon.icns` 与 `app.asar/icon.png` 并刷新完整性与签名的轻量脚本。
- `scripts/`：
  - `build-renderer.js`：将 `src/renderer/` 各源文件拼装编译为 `payload/dist/meter-renderer.js`。
  - `pack-hakimi-asar.js` / `replace-asar-icon.js`：委托 `payload/dist/hakimi-asar-packer.js` 解包官方 `app.asar`、清理遗留注入、写入 4 处 `dist/utils.js` 钩子、`dist/preload.js`、Remote SSH 钩子（`dist/remote/bootstrapScript.js`、`dist/remote/remoteManager.js`）及 `dist/updater.js` 模块边界接管包装，支持替换内置 `icon.png`，并输出 Header SHA-256。
  - `build-macos-icon.js`：本地图片转换为 macOS `.icns` 与 `512x512` Dock PNG（默认按透明边缘自适应裁剪 + 圆角遮罩）。
  - `region-unlock.js` / `cli-unlock.js` / `doctor.js`：账号地区解锁 CLI、`agy` CLI 地区解锁 CLI、只读健康诊断工具（含 `hakimi_updater` 与语义化 `hakimiAhead` 版本同步核查）。
  - `lib/target-app-lifecycle.sh`：`build-hakimi.sh` 与 `set-hakimi-icon.sh` 共用的目标 `.app` 进程探测与零存活退出屏障。
- `payload/dist/`：
  - `asar-engine.js`：纯 Node ASAR 读写引擎、`computeAsarHeaderSha256()`、`getHakimiAppPath()`、`assertNotOfficialAntigravityApp()`。
  - `hakimi-asar-packer.js`：自包含 ASAR 打包器（以 Buffer 读写内置载荷以兼容 Electron 虚拟 `app.asar` 自举、包装接管 `dist/updater.js` 并保留 `dist/updater.orig.js`）。
  - `hakimi-builder.js`：官方 `app-update.yml`/`latest-arm64-mac.yml` 解析与白名单 HTTPS 拉取、`SHA-512` 与 Google Developer ID 代码签名校验、GitHub `main` 提交对比（`compare/<installed>...main`）与 tarball 拉取、`hakimi-build-meta.json` 读写、APFS 沙盒试构建（`ELECTRON_RUN_AS_NODE=1`）及启动 Orphan GC。
  - `hakimi-icon-manager.js`：自包含 macOS 图标转换、实时预览渲染（支持圆角遮罩切换）、ASAR `icon.png` 替换、默认图标自动快照与多源还原（只读官方包 → 单槽 `clean-base` 缓存 → 本地快照）、APFS CoW 沙盒校验及复用的脱离式冷替换编排（`scripts/build-macos-icon.js` 与 `scripts/replace-asar-icon.js` 均委托于本模块）。
  - `hakimi-updater.js`：双源静默检测与沙盒试构建状态机、不兼容版本跳过与仅哈基米升级回退、`dist/updater.js` 接管桥接及 macOS 菜单栏更新项同步。
  - `hakimi-upgrade-helper.js`：零外部依赖的脱离式冷替换工作进程（仅用 Node 内置模块），负责官方包守卫、零存活退出屏障、`SingletonLock` 清理、同盘 APFS 原子替换（`.prev` 失败自动回滚）、单槽位 `clean-base` 缓存晋升与干净环境 `open -n` 拉起（同时服务于双源自更新与应用内换图标，通过 `job.resultPath` 隔离结果回执）。
  - `binary-utils.js`：公共 Go `.gopclntab` 符号定位与 ARM64 `ValidateAndOnboardAccount` 分析工具。
  - `modular-installer.js` / `modules-config.js`：`app.asar` 注入代码生成与状态目录持久化工具（含 `cleanupStaleSingletonLock()` 与语义化 `checkAppVersionSync()`）。
  - `meter-region-unlock.js`：自适应 Mach-O `__TEXT` + Go `.gopclntab`（`0xFFFFFFF1` / `0xFFFFFFF0`）符号解析器，定位 `authclient.ValidateAndOnboardAccount` 并修补 `"free-tier"` 分支。
  - `meter-cli-unlock.js`（与 `unlock/agy-cli/agy-patch.py`）：macOS ARM64 Mach-O 与 Linux ELF64（`x86-64` PIE & `arm64`）`agy` CLI 自适应地区解锁。
  - `meter-enhance.js`：仅限 `哈基米.app` 副本的后台 `language_server` 进程检测与重启辅助模块。
  - `meter-ssh.js`：Remote SSH 远端 Linux ELF64（`x86-64` & `arm64`，含 PIE `.rela.dyn` `firstmoduledata` 解析）自适应地区解锁、`bootstrapScript.js` POSIX `sh` 装饰器、远端会话内存注册表及 Electron `session.fetch` 代理通道。
  - `meter-account-cold-helper.js`：零外部依赖的脱离式冷切账号工作进程与公共钥匙串原语（仅用 Node 内置模块），负责零存活退出屏障、`SingletonLock` 清理、钥匙串原子换盘、账号局部残留清理、已保存账号引导状态还原与干净环境 `open -n` 拉起。
  - `meter-account-switcher.js`：macOS 钥匙串多账号冷切换编排器（仅元数据探测 Vault 存在性、`agy` CLI 并发拦截、释放并拉起独立 helper、账号快照保存/改名/删除）。
  - `meter-main.js` / `local-api.js` / `meter-collector.js` / `meter-core.js` / `meter-storage.js` / `attachment_scan.py`：主进程 IPC（严格区分本机与 SSH 窗口）、本地 API、对话轨迹采集、纯 Token 与模型额度统计、历史存储与附件预算估算。
  - `i18n/i18n-runtime.js` & `i18n/zh-CN.json`：桌面端界面全量简体中文运行时（仅作用于本地 Electron DOM，支持简体中文 / 英文切换）。
- `src/renderer/`：Context Meter 悬浮胶囊、顶栏布局与 `/compact` / `#btn-topbar-upgrade` 按钮、左下角模型额度/Effort/快捷键卡片、多账号冷切换浮层与未登录兜底胶囊、速率对比、纯 Token 热力图与设置面板（含双源更新诊断卡片）源码（`template.html`、`styles.css`、`i18n.js`、`colors.js`、`topbar-layout.js`、`dropdown.js`、`model-switcher.js`、`model-quota.js`、`account-switcher.js`、`speed-panel.js`、`settings-panel.js`、`heatmap.js`、`main.js`）。
- `test/`：
  - `hakimi-updater.test.js`：脱离式冷替换 helper 零依赖与 `.prev` 自动回滚、单槽位缓存/Orphan GC、官方 YAML/`SHA-512`/Google 验签、GitHub `compare`、双源状态机与回退、`dist/updater.js` 接管、`checkAppVersionSync()` 三态语义化比较与渲染层 VM DOM 测试。
  - `icon-manager.test.js`：应用内换图标预览（圆角遮罩/原图直出/透明轮廓/`.icns`）、官方路径守卫、APFS 沙盒 `codesign --verify --strict`、多源恢复默认图标（官方包/自动快照/单槽 zip）、冷替换结果隔离与渲染层配置卡片/SSH 隐藏测试。
  - `account-switcher.test.js`：macOS 钥匙串冷切引擎、零 `-w` 元数据探测、`agy` CLI 拦截、账号局部残留清理与引导状态还原、退出屏障、独立 helper 零依赖运行与官方包守卫测试。
  - `arm64-patches.test.js`：Mach-O / `.gopclntab` / ARM64 地区解锁与官方路径守卫测试。
  - `asar-and-pruning.test.js`：语法校验、裁剪符号与零外发请求拦截扫描、DOM 结构与顶栏不变量、ASAR 打包/图标替换、官方路径守卫、`doctor` 与重启退出屏障测试。
  - `cli-linux-elf.test.js` / `cli-region-unlock.test.js`：Linux ELF64（`x86-64` PIE & `arm64`）与 Python3 `agy-patch.py` 一致性及 CLI 地区解锁契约测试。
  - `model-quota.test.js`：模型额度分桶解析、左下角侧栏停靠/折叠记忆、Effort 速切、快捷键持久化与轮次后 10 分钟冷却刷新测试。
  - `ssh-remote.test.js`：Linux ELF64 Node + Python3 自适应地区解锁一致性、POSIX `sh -n` 校验、ASAR 往返注入与 SSH 远端采集器隔离测试。

---

## 5. 关键不变量与常见踩坑

1. **macOS 多账号冷切换安全与防串号约束**
   - `payload/dist/meter-account-cold-helper.js` 必须保持**零外部相对依赖**（仅 `require` Node 内置模块），确保从 `app.asar` 释放到 `runtime/cold-switch-helper.js` 后，无论由本机 `node` 还是 `ELECTRON_RUN_AS_NODE=1` 拉起均可独立执行。
   - **零明文落盘与最小内存暴露**：钥匙串写入必须走 `/usr/bin/security -i` stdin 管道并经 `shellEscapeForSecurity()` 拦截控制字符；传给 helper 的任务 JSON、日志与 `account-profiles-v1.json` 严禁写入任何 OAuth Token；状态刷新（`getAccountsStatus`）使用不带 `-w` 的 `find-generic-password` 探测 Vault 存在性。
   - **严格冷切与局部清理边界**：切号前拦截运行中的 `agy` CLI（含 `--app_data_dir antigravity-cli` 的 `language_server`）；必须在 `哈基米.app` 与子进程全部零存活后再换盘，清理 `~/.gemini/jetski-standalone-oauth-token`、`~/.gemini/cache/antigravity-keyring-unavailable`、`credential-user-scope` 与 3 个缓存 Mendel 开关，并在切向已保存账号时同步写回目标账号的 `agy.onboarding.lastLoginUsername` / `lastLoginIsGcpTos`（避免重复弹出「开始前的最后一步...」引导窗）；**严禁**改动 `installation_id`、`antigravity_state.pbtxt`、共享对话库或 `Antigravity Safe Storage`。
   - 仅限 macOS 本机主窗口使用，Remote SSH 窗口必须禁用并隐藏入口。
2. **双源静默升级、原生更新器接管与磁盘防囤积约束**
   - `payload/dist/hakimi-upgrade-helper.js` 必须保持**零外部相对依赖**（仅 `require` Node 内置模块），释放到运行时目录后可脱离即将被替换的 `app.asar` 独立完成零存活退出屏障、`SingletonLock` 清理、同盘 APFS 原子替换（`.prev` 自动回滚）与干净环境 `open -n` 拉起；全程经 `isOfficialAntigravityBundle()` 守卫。
   - **仅成功才提示与不降级开发版**：后台沙盒构建全套校验通过后才进入 `ready` 并点亮顶栏 `#btn-topbar-upgrade`；失败时顶栏保持安静，仅在设置面板写入失败诊断并记住不兼容版本直到 `main` 有新提交。判断哈基米更新须用 `hakimi-build-meta.json` + GitHub `compare/<installed>...main`，仅在 `ahead` 时触发。
   - **磁盘防囤积与 Orphan GC**：官方干净 `Antigravity.zip` 严格保持单槽位缓存（仅保留与当前已安装版本匹配的一份，并避免与 `~/Library/Caches/com.google.antigravity/` 重复留存）；哈基米源码 tarball 与失败 staging 立即 `rm -rf`，原子替换成功后立刻删除 `.prev`；每次启动执行 Orphan GC 清扫残留。
   - **原生更新器接管与版本同步**：`dist/updater.js` 模块边界包装接管后保持原生 `updater:state-changed` 为 `idle`（彻底禁用 Squirrel.Mac 验签冲突）；Remote SSH 窗口必须隐藏入口并拒绝所有升级 IPC；`checkAppVersionSync()` 采用语义化版本比较，当 `hakimiVersion > officialVersion` 时返回 `outdated: false, hakimiAhead: true`。
3. **渲染层模板与交互约束（均受自动化单测强制校验）**
   - `src/renderer/template.html` 中 `<div` 与 `</div>` 数量必须**严格相等**。
   - 一级顶栏快捷按钮（`#btn-topbar-compact`）必须保持**纯图标（仅含 `<svg>`），可见文本必须为空**，说明文案仅通过 `aria-label` / `data-tip` 悬停展示；`src/renderer/topbar-layout.js` 的 `ResizeObserver` / `MutationObserver` 须持续观测 `rightGroup`（`pane-titlebar-toolbar`）并计入 `#btn-topbar-upgrade` 宽度。
   - `#ag-model-quota-host` 与 `#ag-accounts-host` 均为独立 Shadow DOM 宿主，不得嵌套在顶栏 `#ag-context-meter` 内部；左下角额度卡片停靠在左侧栏导航内「设置」页脚正上方。
   - 本项目只统计**纯 Token 用量**，不要新增任何金额/计价估算逻辑或恢复已删除的 `#ctx-breakdown-card`。
4. **macOS Apple Silicon 签名、Inode 缓存与重启黑屏陷阱**
   - 替换/重打包 `app.asar` 后必须同步更新 `Info.plist` 中 `ElectronAsarIntegrity['Resources/app.asar'].hash`（由 `computeAsarHeaderSha256()` 计算），否则 Electron 启动会校验崩溃。
   - 签名参数不可混用：`Contents/Resources/bin/language_server` 需加 `--options runtime --entitlements`；外层 `/Applications/哈基米.app` **绝对不能**加 `--options runtime`（否则 Library Validation 会拒绝加载 Google 签名的 `Electron Framework`）。
   - 修改 `Contents/MacOS/Antigravity` 或重签名前需先 `cp -p` + `mv -f` 刷新主可执行文件 inode，避免 Apple Silicon 内核 `cs_blob` 缓存旧签名引发 `SIGKILL`。
   - 自动重启已运行 `.app` 时必须经过零存活退出屏障（主进程先行优雅 `SIGTERM` -> 全进程 `SIGTERM` -> 强制 `SIGKILL` + `cleanupStaleSingletonLock()`）后再用清理过环境变量的 `open -n "$APP"` 拉起，否则 `open` 会向濒死的旧 Electron 主进程发送 `activate` 导致空白黑屏窗口。
5. **Remote SSH 远端引导与窗口隔离约束**
   - `meter-ssh.js` 注入 `dist/remote/bootstrapScript.js` 的 POSIX `sh` 代码必须在 `set -u` 下安全运行，且**严禁向 stdout 打印任何内容**（否则会破坏 Antigravity 的 `parseBootstrapLine` 通信协议）；远端补丁日志统一写入 `$agy_datadir/hakimi-patch.log`，失败必须 fail-open 并写 `.hakimi_skip` 防止无限重启循环。
   - `meter-main.js` 与 `local-api.js` 必须通过 `windowBackends.remoteBackendOf` 严格区分本机窗口与 SSH 窗口：**禁止**让 SSH 窗口的 `127.0.0.1:<remotePort>` 写入 `local-api.setLastKnownOrigin()` 或被 `findOriginFromElectronWebContents()` 误选；`shouldInterceptWindowClose()` 必须对 SSH 窗口直接返回 `false`，避免关闭 SSH 窗口时被隐藏而无法触发 `disposeHost`。
