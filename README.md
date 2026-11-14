# Antigravity Unlock

用于解决中国区 Google 账号登录 Google Antigravity 时遇到的地区资格限制问题，例如：

> Sorry, this account is ineligible to use Antigravity

脚本调整客户端对 `free-tier` 不可用结果的处理，生成独立的 **Antigravity Patched.app**，保留原版应用。仓库用于持续维护和适配新的 Antigravity 客户端构建。

## 当前支持

| 项目 | 支持情况 |
| --- | --- |
| 平台 | macOS，Apple Silicon / ARM64 |
| 客户端版本 | 已核验的 2.32.1 构建 |
| Google AI Ultra | 已实测可用 |
| Google AI Pro | 使用相同补丁逻辑，尚未实测 |

脚本会验证原始 `language_server` 的完整 SHA-256：

```text
f5377993d29bc1036ed9ddbfb2aec55bb37b8aaaf811df4a8c3ed5763dde2db0
```

摘要不匹配时停止处理。同版本的其他构建、已经打过补丁的文件和更新后的版本，都需要单独核验。

## 使用

需要已安装的 Antigravity 原版、Python 3，以及 macOS 自带的 Bash 和 `codesign`。

```bash
git clone https://github.com/cli117/antigravity-unlock.git
cd antigravity-unlock
bash antigravity-unlock.sh
```

默认输入优先使用 `/Applications/Antigravity.app.orig`；该路径不存在时使用 `/Applications/Antigravity.app`。脚本在临时副本上完成补丁、重签名和校验后，保存为：

```text
/Applications/Antigravity Patched.app
```

两个应用共用登录、设置和单实例机制。先退出当前 Antigravity，再打开补丁版：

```bash
open "/Applications/Antigravity Patched.app"
```

脚本完成后由用户自行启动应用。目标路径已存在时会停止，可以指定另一个输出路径：

```bash
bash antigravity-unlock.sh \
  --from "/Applications/Antigravity.app" \
  --app "/Applications/Antigravity Patched Test.app"
```

仅在临时目录生成并校验副本：

```bash
bash antigravity-unlock.sh --stage-only
```

## 生效范围

补丁处理 `authclient.ValidateAndOnboardAccount` 中的客户端 `free-tier` 资格判断，覆盖该分支中的不可用原因。服务端档位检查、后续用户状态请求和模型请求仍按原有流程执行。

Pro 和 Ultra 使用相同处理逻辑，最终可用性仍取决于账号在服务端获得的有效档位和权限。补丁本身不提供订阅权益或额外额度，也不能保证服务端拒绝的账号能够使用。

重签名会将副本改为本地 ad-hoc 签名。应用更新可能覆盖补丁，更新后的构建需要重新适配。

## 维护与适配

仓库名和脚本名保持稳定，支持范围随核验结果更新。适配新客户端构建时：

1. 核对原始文件版本、架构和 SHA-256。
2. 分析目标函数的控制流，准确区分 `allowedTiers` 与 `ineligibleTiers` 判断。
3. 更新对应构建的匹配条件和摘要，并验证预期指令之外的程序逻辑保持一致。
4. 在应用副本上验证签名、登录和实际请求，更新本 README 的支持情况。

完整文件摘要和指令匹配必须一起核验。报告兼容性问题时，请附客户端版本、系统架构和脱敏后的脚本输出。
