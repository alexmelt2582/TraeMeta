# 交接文档：Trae Meta 增强器（合并版 TRAE）

> 用途：在新的工作目录/仓库里从零开展 **Trae Meta** 增强器的开发。
> 本文是决策与事实的唯一载体，新会话应先读本文，再动代码。
> 编写时间：2026-10-11

---

## 1. 背景（已核实的事实）

### 1.1 官方把两个客户端合并了
- 2026-10-09 TRAE 官方公告：**TraeWork（SOLO）与 TraeCode 正式合并为全新的 TRAE**，账号、登录状态、本地数据、商业积分完整保留并迁移。
- 合并后的客户端是 **TraeCode 血统**（VSCode 系 workbench），不是 TraeWork 血统。

### 1.2 本机安装情况（截至 2026-10-11）
| 客户端 | 路径 | product.json | 用户数据目录 | 状态 |
|---|---|---|---|---|
| **合并版 TRAE**（今后主用） | `D:\ProgramFiles\Trae CN\Trae CN.exe` | nameShort=`Trae CN`，appVersion=`3.4.2` | `%APPDATA%\Trae CN` | 运行中 |
| 旧 TraeWork/SOLO（退场） | `C:\Users\ZHD\AppData\Local\Programs\TRAE SOLO CN\TRAE SOLO CN.exe` | nameShort=`TRAE SOLO CN`，appVersion=`0.1.65` | `%APPDATA%\TRAE SOLO CN` | 运行中 |

### 1.3 两个增强器仓库（都属本人 alexmelt2582）
| | 仓库 A（功能全，作为**功能来源**） | 仓库 B（作为**客户端适配来源**） |
|---|---|---|
| 本地路径 | `d:\Me\副业\Trae多账号协同` | `D:\Me\副业\TraeTraeCode增强` |
| 远端 | `alexmelt2582/traedabby` | `alexmelt2582/TraeCodeDaddy` |
| 版本 | v1.4.0 | v1.0.1 |
| 目标客户端 | `TRAE SOLO CN.exe` | `Trae CN.exe`（= 合并版） |
| 根提交 | `cd1f6cd` | `ac09b13` |
| 安装位置 | `D:\ProgramFiles\TRAE SOLO CN Enhancer\TraeEnhancer.exe` | `D:\ProgramFiles\TraeCode CN Enhancer\TraeCodeEnhancer.exe` |

**关键结论：A 与 B 没有共同祖先（不是 fork 关系）**，所以两个仓库之间**不能 git merge / cherry-pick**，只能逐模块人工搬运。

### 1.4 模块清单差异（A 35 个 lib，B 30 个）
- **A 有、B 没有（要从 A 带过去的"功能"）**：`app-update.js`、`app-installer.js`、`system-proxy.js`、`system-ca.js`、`proxy-runtime.js`、`device-identity.js`
  —— 对应三块功能：**助手自更新、代理、设备身份**。
- **B 有、A 没有（要保留的"客户端适配"）**：`ws.js`
  —— 合并版 workbench 的 CSP 禁止 `connect-src http:`，面板与守护进程必须走 **WebSocket（`ws://…/panel`）**。

### 1.5 账号/凭据实测（非常重要，别再做错假设）
用 A 的 `trae-crypto.js` 解密两边 storage 后按哈希比对（未打印任何 token 明文）：

| | 旧 SOLO 客户端 | 合并版 Trae CN |
|---|---|---|
| 当前登录 userId（尾号） | `…772779` | `…248951` |
| refreshToken 哈希 | `9b8c143a9816` | `9454e36e99e1` |
| access 到期 | 2026-10-24 | 2026-10-23 |

- 两个客户端各自独立登录、各自一条 refresh token 链，**互不影响**。
- 因此：**A 增强器和 B 增强器同时跑不会互相顶掉 token**（各管各的客户端）。
- 真正会冲突的唯一情形：**两个增强器指向同一个客户端 / 同一份 storage**（这次是同一台合并版客户端）。所以 TraeCode 增强器必须让位（见决策 D1）。
- 注：grabbing 同名账号 `…248951` 在两个增强器里都存在，但记录的是两条独立链路。

---

## 2. 目标

新建仓库 **Trae Meta**：一款面向**合并版 TRAE（`Trae CN.exe`）**的增强助手。

- **功能**：与仓库 A（v1.4.0）**全量一致**（多账号保存/切换、备份导出、签到、keep-alive、手动续签、积分查询/到期提醒/构成饼图、面板/设置/关于页、助手自更新、代理配置、TRAE 更新开关、托盘/自启动/窗口聚焦、构建与打包发布链）。
- **底层客户端适配**：参考仓库 B（目标 exe、用户数据目录、产品标记、产品鉴权键、WebSocket 传输）。
- **版本线**：从 **v2.0.0** 起。

---

## 3. 已定决策

| # | 决策 | 结论 |
|---|---|---|
| D1 | TraeCode 增强器（B）让位 | **用户手动卸载** `D:\ProgramFiles\TraeCode CN Enhancer`，新增强器不再与它共存 |
| D2 | 产品命名 | **Trae Meta** |
| D3 | 版本线 | 从 **v2.0.0** 起 |
| D4 | 旧 SOLO 客户端 | 退场，但**不卸载**（保留 `data/`，观察一周）；旧 SOLO 增强器 A 的 `main` 冻结为"旧客户端维护线"，不收新功能 |
| D5 | 种子方式 | **未决**（见 §4） |

### 3.1 命名/身份方案（Trae Meta）
因为 `TraeEnhancer.exe` 是仓库 A 已发布的文件名，新产品的内部身份**必须全部换新**，否则与 A 撞单实例互斥、托盘、自启动 Run 值名、Inno AppId、安装目录、卸载项：

| 项 | 取值 |
|---|---|
| 产品名 `APP_NAME` | `Trae Meta` |
| 可执行文件名 | `TraeMeta.exe`（← 与 A 的 `TraeEnhancer.exe` 不再同名，冲突自动消失） |
| 安装目录 | `Trae Meta`（建议 `%LOCALAPPDATA%\Programs\Trae Meta`） |
| CDP 端口 | `9337`（A=9334，B=9336） |
| UI 端口 | `47837`（A=47834，B=47836） |
| 环境变量前缀 | `TRAEMETA_ENHANCER_*`（A 占 `TRAE_ENHANCER_*`，B 占 `TRAECODE_ENHANCER_*`） |
| GitHub 仓库 | `alexmelt2582/TraeMeta` |
| 安装包产物 | `TraeMeta-Setup-<version>.exe` / `TraeMeta-Portable-<version>.zip` |
| 自更新资产匹配 | `TraeMeta-Setup-<version>.exe` |
| 下载临时目录 | `%LOCALAPPDATA%\Temp\TraeMeta-Update\` |
| Inno `AppId` | **新 GUID**（绝不能沿用 A 的） |

---

## 4. 唯一未决项（新工作区先确认）

- **Q：新仓库的种子方式**——(a) 从仓库 A 的**历史**起步（保留合并基，将来 A 给旧客户端修的 bug 还能 merge 过来，但不要推 A 的 tags）；(b) 一次干净导入（`git init` + 拷 A 整棵树 + 单个初始提交，历史干净但以后无法 merge A）。
  **建议 (a)**：本项目后续一定会从 A 抄修复，保留合并基省事；不推 A 的 tags 即可避免新仓库平白多出 `v1.4.0`。

---

## 5. 实施步骤（按仓库 A 既有的 `feature/*` 发布流程）

1. 建新仓库 `alexmelt2582/TraeMeta`，按 §4 选定方式导入 A 的代码。
2. 改 `package.json` / `src/constants.js`：`APP_NAME`、`APP_VERSION=2.0.0`、`GITHUB_REPO`、端口、env 前缀。
3. **替换客户端适配层**（见 §6）。
4. **身份重命名全量扫描**（见 §7）。
5. 写/改新仓库的 `AGENTS.md`（承接 A 的规则，替换产品定位/客户端/端口/仓库名）。
6. 本地跑通：`npm test`、`npm run check`、`npm run build:exe`、`npm run build:installer`。
7. 实测注入合并版客户端并验收（见 §8）。
8. 打包 `npm run release:pack` → 用户本地验收 → 用户说"验收通过，发布 v2.0.0"后 `npm run release:publish`。

---

## 6. 必须替换的客户端适配点

| 文件 | 现状（A，旧客户端） | 改成（B 的做法，合并版） |
|---|---|---|
| `src/constants.js` | `DEFAULT_TRAE_EXE` = `%LOCALAPPDATA%\Programs\TRAE SOLO CN\TRAE SOLO CN.exe` | `D:\ProgramFiles\Trae CN\Trae CN.exe`（注意：合并版装在非默认盘，默认值要不要按 `D:\ProgramFiles` 还是走注册表探测，需在实现时决定） |
| `src/constants.js` | `DEFAULT_TRAE_USER_DATA_DIR` = `%APPDATA%\TRAE SOLO CN` | `%APPDATA%\Trae CN` |
| `src/lib/trae-locate.js` | 目标 exe/进程名 = `TRAE SOLO CN.exe` / `TRAE SOLO CN` | `Trae CN.exe` / `Trae CN` |
| `src/lib/trae-product.js` | 读 `iCubeApp.authConfig.SOLO` | 读 `iCubeApp.authConfig.TRAE`，并兼容 `bootConfig.iCube`；注册表 `DisplayIcon` 判定要走合并版条目（`TRAE CN (User)`） |
| 面板↔守护进程传输 | 仓库 A 用 HTTP（`POST /api/inject` 等） | **引入 B 的 `src/lib/ws.js`，面板走 `ws://…/panel`**；A 的 `inject.js` 里所有对守护进程的 HTTP 调用点都要改为 ws |

> ⚠️ 传输层是**必须重做**的部分，不是改常量。合并版是 VSCode 系 workbench，CSP 禁 `connect-src http:`。实现前先只读盘清 `src/ui/inject.js`（A 约 3700+ 行）里所有 http 调用点。

---

## 7. 身份重命名：写死 `TraeEnhancer` / `TRAE SOLO CN Enhancer` 的位置（需全量 grep 后逐个改）

已知的写死点（用 `TraeEnhancer` 全量 grep 补充）：
- `scripts/build-exe.js:31` `EXE_NAME = "TraeEnhancer.exe"`
- `scripts/release-pack.js:32-33,51` `SETUP_BASE` / `PORTABLE_BASE` / 产物清单
- `scripts/release-publish.js:30-31` `SETUP_BASE` / `PORTABLE_BASE`
- `scripts/win/trae-enhancer.iss`：`OutputBaseFilename`、`ProductExe`、`AppId`、`AppName`、安装目录、卸载保留 `data\` 的文案
- `scripts/trae-enhancer.cmd:12,14`（找 exe 名）
- `scripts/launch-hidden.vbs`（**构建产物**，由 `build-exe.js` 生成，不在仓库里，别手写）
- `src/lib/autostart.js`（生成的 vbs 里引用的 exe 名）
- `src/lib/app-update.js`：`GITHUB_REPO` + 资产名 `TraeEnhancer-Setup-<version>.exe`
- `src/lib/app-installer.js`：下载临时目录名
- `src/daemon.js:668`、`src/sea-entry.js:9`、`scripts/service.js:824` 等用户可见文案
- `test/*.test.js`：大量断言里含 `TraeEnhancer`

> 改完用 `npm run check` + `npm test` 兜底（`test/packaging-assets.test.js` 会强制安装器脚本与构建产物一致）。

---

## 8. 验收清单（本地实测）

- [ ] 注入：走桌面/开始菜单快捷方式（`launch-hidden.vbs`）或 `TraeMeta.exe start` 启动合并版，面板能注入；**直接双击 `Trae CN.exe` 不注入**属预期。
- [ ] CDP 端口 9337 属于本项目自己启动的 `Trae CN.exe`（不是复用别人的）。
- [ ] 账号：识别合并版当前登录账号，保存/切换/备份导出可用。
- [ ] 签到：手动跑一次 `POST /api/checkin/run` 成功；再开自动签到。
- [ ] keep-alive：仅到期才轮换；非活跃账号轮换后不影响合并版自身登录。
- [ ] 积分：查询正常；到期提醒与构成饼图口径按合并版实际返回校准（**分账口径可能和旧 SOLO 不同，先实测再定**）。
- [ ] 助手自更新：`GET /api/update` 指向新仓库 `TraeMeta`，资产匹配 `TraeMeta-Setup-*.exe`。
- [ ] 代理：off/system/custom 三态可存可生效。
- [ ] 不碰旧客户端：整个过程不改 `%APPDATA%\TRAE SOLO CN`、不杀旧客户端进程。

---

## 9. 风险与约束

1. **不要动旧客户端和旧增强器**：D4 只冻结，不卸载不动数据。
2. **B 必须先卸载**（D1）才能上线新增强器，否则两者指同一份 storage、同一条凭据链，会真冲突。
3. **安装路径在非默认盘**（`D:\ProgramFiles\Trae CN`）：定位逻辑要能通过注册表（`DisplayIcon` 文件名 `Trae CN.exe`，产品名 `TRAE CN`）找到它，别只按 `%LOCALAPPDATA%\Programs` 猜。
4. **新仓库要遵守 A 的硬约束**：`main` 不许直接改，一律 `feature/*` 分支；发布本地完成、不走 GitHub Actions；提交信息中文 Conventional Commits；源码 UTF-8 无 BOM；`data/`、`logs/`、`dist/`、`node_modules/` 不提交。
5. **账密安全**：绝不打印/落盘 token、cookie、完整认证快照；日志走 `redactLogLine`。
6. **这次的教训**：不要把"两个工具轮换相同 refreshToken 会互相失效"这条（针对同一份 storage）错误地套到"两个增强器各管一个客户端"上——实测两套 token 独立。

---

## 10. 参考位置速查

- 仓库 A（功能来源，只读参考）：`d:\Me\副业\Trae多账号协同`
- 仓库 B（适配来源，只读参考）：`D:\Me\副业\TraeTraeCode增强`
- 合并版客户端：`D:\ProgramFiles\Trae CN\Trae CN.exe`，数据 `%APPDATA%\Trae CN`
- 待卸载的旧增强器：`D:\ProgramFiles\TraeCode CN Enhancer`
