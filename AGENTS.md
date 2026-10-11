# Project Rules

## 发布流程
本项目遵循 `docs/RELEASE_FLOW.md` 中的流程。

核心规则：
- `main` 是唯一长期分支，禁止直接推送。
- **严禁直接在 `main` 分支上进行任何代码改动或提交**：一切功能/修复/调整都必须先创建 `feature/*` 分支，在分支上完成后按流程合并回 `main`。如已在 `main` 上有未提交改动，必须先切到新分支再操作。
- 功能开发从 `main` 创建 `feature/*` 分支。
- 开发完成后，AI 执行构建和打包，生成发布包，等待用户本地验收。
- 用户说“验收通过，发布 vX.Y.Z”后，AI 才能执行发布。
- 发布动作：合并功能分支到 `main`，推送 `main`，打标签 `vX.Y.Z`，推送标签。
- 发布不经过 GitHub Actions，也没有 `.github/workflows`，禁止把发布步骤移回 Actions：全部在本地完成。`npm run release:pack`
  构建并汇总产物到 `dist/release/vX.Y.Z/`（每个版本一个目录，互不覆盖）；发布说明写入 `docs/releases/vX.Y.Z.md`，先提交再打标签，
  使标签指向的提交自带该版本说明；推送标签后用 `npm run release:publish` 创建 Release 并上传产物。
- 禁止创建 `release/*` 或 `develop` 分支。
- 禁止强制推送 `main`。
- 提交信息遵循 Conventional Commits；**每个提交的标题与正文描述信息一律使用中文书写**。



## 产品定位

本仓库是 Windows 上 `Trae CN` 的本地增强助手。
它不得修改官方安装包或 `app.asar`。
它通过 Chrome DevTools Protocol 与正在运行的 Electron 渲染进程通信，
并将所有账号数据保留在本机。

TRAE 自身文件它唯一允许写入的是用户级 `User/settings.json`，
且仅写入其中的 `update.mode` 一项。账号状态、工作区、历史记录以及其它所有设置均保持原样。

## 账号模型

- 账号切换复用与官方客户端相同的共享 TRAE user-data 目录。
- 备份只包含 TRAE 认证状态，而不是整个 user-data 目录。
- 认证快照必须包含账号维度的 `iCube*` 键，以及与之匹配的 device-key/usertag 记录。
- 工作区、设置、扩展、窗口状态等非认证键必须保留。
- 切换是事务性的：校验、备份、原子替换、验证、失败回滚。
- 事务回滚仅使用内存状态。不要持久化原始的 `storage.before.json` 或旧版
  `state.before.vscdb` 副本。
- 将 `unknown` 之类的哨兵身份值规范化为 `null`；绝不把它们存为账号元数据。
- 账号导出必须始终使用用户提供的密码加密。绝不把密码或明文认证快照写入磁盘或日志。
- 签到请求必须使用每个账号稳定的 `userId` 作为 `x-device-id`。绝不跨账号共享
  一个机器生成的设备 id。
- 签到端点由 `https://api.trae.cn` 提供；不要改用账号专属的 `loginHost`。
- Keep-alive 只能为非活跃账号轮换凭据，且仅在到期时：访问令牌剩余不足一天、
  或刷新令牌剩余不足一个月时才交换。仍有剩余天数的凭据必须原样使用，因为交换它
  会使持有同一链路的其它所有设备失效。活跃账号必须从正在运行的 TRAE 存储同步，
  且不得直接基于备份轮换其刷新令牌。
- 账号切换使用相同的到期保护（`refreshAuthSnapshotIfNeeded`）。不得仅仅因为目标
  账号被选中就交换它；之后的 401 是允许轮换一次的显式重试点。
- 识别活跃账号得到三种状态而非两种：`matched` 走同步路径；`not-managed`
  （TRAE 持有已保存列表之外的账号）是安全的，可正常轮换；`unknown`（完全无法读到
  当前身份）必须跳过整个扫查并记录原因，因为此时轮换可能使一个我们不可见的会话
  失效。绝不要把 `unknown` 折叠为 `not-managed`，也绝不把它当成"无需 keep-alive"。
- 在 Cockpit Tools 运行时跳过自动签到与 keep-alive。两个工具轮换相同的刷新令牌
  会互相失效。
- 当 Cockpit Tools 探测无法判定（`unknown`）时，签到仍会执行，但拒绝凭据轮换，
  并跳过 keep-alive。两条路径现在都只在到期时轮换，因此拒绝正是消除剩余重叠的机制。
- 注入的面板是 `data/accounts/index.json` 的纯视图。它绝不能自行推导签到状态；
  每次状态变化后由守护进程通过 CDP 推送 `traemeta:accounts-updated`，面板在该
  事件及打开时重新读取。不做任何轮询。
- 打开面板会请求守护进程对账（`POST /api/accounts/panel-open`）。
  该调用是幂等的：已在服务器签到的账号按已签到记录，不会重复领取奖励。
- 面板绝不能响应守护进程推送而请求刷新积分。守护进程在自身刷新后已经推送，
  因此那样会造成死循环。
- 签到总奖励是 `credits`；`extra_credits` 只是附加项，不得作为总数展示。
- 账号备份失败必须在返回 500 之前先写一行日志。面板的空状态无法区分
  "还没有保存任何账号"与"接管当前账号失败"，因此该日志是差异存活的唯一位置。

## 安全

- 本地服务只绑定 `127.0.0.1`。
- 绝不记录或暴露访问令牌、刷新令牌、cookie、私钥或完整认证快照。
- 只管理可执行文件路径和 user-data 目录与所配置的 Trae CN 安装匹配的进程。
- 绝不关闭所有 Electron 进程，也不使用宽泛的按进程名终止。
- 源码文件和 JSON 数据使用无 BOM 的 UTF-8。
- 后台监督进程只*启动*守护进程。它从不终止任何东西，因此完全不需要 kill 路径。
- 停止服务只使用两个精确的 pid，且仅此两者：来自 `/api/health` 的守护进程 pid
  和来自 `data/watchdog.pid` 的监督进程 pid。终止前先确证该 pid 属于本项目自己的
  进程镜像；宁可拒绝并报告，也不要猜测。
- 项目目录可能包含非 ASCII 字符。绝不把该路径写进 `.cmd`、`.vbs` 或 `.ps1`
  源码文件：通过 COM（UTF-16）创建快捷方式，并让生成的脚本在运行时从自身位置
  解析项目根目录。
- `scripts/trae-meta.cmd`、`scripts/tray.ps1`、`scripts/launch-hidden.vbs` 以及
  所有生成的自动启动脚本必须保持纯 ASCII 且无 BOM。请依靠 `src/lib/autostart.js`
  中的 `assertAscii` 来强制这一点，并把中文显示字符串放到 `data/tray-config.json`
  （UTF-8）中。
- 绝不把路径通过 `JSON.stringify` 传入 VBScript：那里的 `\\` 不是转义符，
  会静默损坏路径。请使用 `vbsQuote`。

## 运行时不变式

- 本仓库使用标准 `.git` 目录；直接运行 `git` 命令即可，无需 `--git-dir`。
- 默认回环服务是 `http://127.0.0.1:47837`；CDP 默认为 `127.0.0.1:9337`。
- 签到每 `config.checkin.intervalMinutes`（15/30/60/120，默认 30）扫查一次，并且
  每个 Asia/Shanghai 天最多领取一次。`config.checkin.auto` 只禁用这些自动扫查：
  打开面板和 `POST /api/checkin/run` 是用户动作，绝不会被它拦。

- 签到设置无需重启即生效。在触发发生时读取配置，绝不在构建定时器时读取，并使用
  `initialRun: false` 重建计划——保存设置绝不能在后台顺手领取奖励。
- 一次成功的 CDP 连接会执行一次签到，并在列表仍为空时接管已登录账号。两者都
  每次连接只发生一次，仅断开时重装。接管在每次进程运行中只尝试一次；在所有重连
  时重试可能会接管用户手动移除的账号。
- Keep-alive 每 30 分钟扫查一次。非活跃账号每六小时处理一次，失败后 30 分钟重试；
  凭据仅在到期时交换，因此多数扫查只是刷新洞察。
- 面板显示每个账号的凭据到期时间，来源是 `keepalive.accessExpiresAt`
  和 `keepalive.refreshExpiresAt`。这两个字段是携带在 keep-alive 载荷内的显示元数据
  ——它们不增加索引模式。
- 面板打开时，这两个字段也会从账号快照填充
  （`AccountStore.fillCredentialExpiryFromSnapshots`），因为写入它们的扫查可能在
  Cockpit Tools 运行或实时身份不可读时被完全跳过。其值与扫查复制的 `auth.expiredAt`
  相同，该填充既不触网也不接触凭据。它绝不能写 `status` 或 `updatedAt`：那里出现
  一个新时间戳会被读成同步完成，并把真正扫查推迟整整一个间隔。
- 经校验的账号快照在保存时也会把两个到期字段写入索引，因此新添加的账号会立即在
  面板中可见，而无需等待首次扫查或下一次打开面板。这仍然保持 `status` 和
  `updatedAt` 不被触碰，也不轮换凭据。
- Keep-alive、签到、账号切换、登录流程与洞察刷新必须互斥。
- 重启守护进程需要停止 `/api/health` 报告的确切 PID。绝不终止所有 Node 或
  Electron 进程。
- 重启绝不原地执行。守护进程会以分离方式生成
  `service daemon --wait-pid <自身pid>` 然后退出，因此新进程只在监听端口释放、
  并移除继承的代理环境控制后才启动（`POST /api/daemon/restart`）。
- 注入面板内的设置标签页是签到与 TRAE 更新选项的唯一 UI。它继承面板既有的
  token 认证和回环端口，因此不会打开新的监听器。
- 监督进程每 15 秒轮询 `/api/health`，连续三次失败后重启守护进程，并在两次尝试
  之间退避 60 秒。
- `data/`、`logs/`、`dist/` 和 `node_modules/` 是本地状态，绝不提交。

## 打包不变式

- 任何*启动*应用的入口都走 `scripts/launch-hidden.vbs`，而不是可执行文件本身。
  打包出的二进制是控制台子系统程序，因此指向它的快捷方式总是会打开控制台窗口。
  只有启动入口被隐藏；`stop` 之类的命令保留其控制台，让用户看到结果。
  `test/packaging-assets.test.js` 会针对安装器脚本强制这一点。
- `scripts/launch-hidden.vbs` 是构建产物，不是仓库里的源文件：`scripts/build-exe.js`
  在组装便携版时把它写进 `dist/portable/scripts/`，安装器再从那里打包。这里写的
  `scripts/launch-hidden.vbs` 一律指安装后的目录结构；在仓库里找不到它是正常的，
  不要为了「补上缺失文件」而手写一份。
- `scripts/win/trae-meta.iss` 必须打包 `scripts/launch-hidden.vbs`；指向一个
  安装器从未复制过的文件的启动快捷方式注定失效。
- `src/lib/app-paths.js` 是唯一允许读取 `import.meta` 的模块。Node 22
  单可执行应用程序只接受 CommonJS 入口，而 esbuild 在该输出格式下会把
  `import.meta` 替换为空对象。构建对打包场景注入 `__APP_BUNDLE_ROOT__`。
- 单个可执行文件无法从磁盘加载同目录脚本。渲染脚本必须作为 SEA 资源
  （`sea-config.json` 中的 `assets`）嵌入，并通过 `src/lib/inject-source.js`
  读取；打包场景下绝不从磁盘读取它。
- 守护进程、监督进程和服务 CLI 通过 `src/lib/launch-spec.js` 中的内部 argv 开关
  重新进入。没有开关时，打包后的可执行文件行为与服务 CLI 完全一致，因此两个入口
  一致。
- `npm run build:exe` 必须验证自身输出：准备产物必须包含渲染标记，产出的
  可执行文件必须能应答 `status`。跳过这些检查的构建不得被报告为可用。
- `npm run build:installer` 打包便携输出，并在该输出缺失或不完整时必须失败；
  它本身从不构建可执行文件。
- `scripts/win/trae-meta.iss` 包含中文字面量，因此必须保持带 BOM 的 UTF-8；
  构建脚本在缺失时补加 BOM。无 BOM 的脚本会被 ISCC 按 ANSI 读取，字面量会变成乱码。
- `scripts/win/ChineseSimplified.isl` 是第三方翻译，按原样使用；绝不重写其字节。
- 安装器绝不从子进程管道读回路径。Node 写 UTF-8，而安装器用系统 ANSI 代码页
  解码管道，任何非 ASCII 路径都会损坏。检测在安装器内部通过注册表和文件检查完成，
  所选路径作为命令行参数*传给*可执行文件，这种方式对 Unicode 安全。
- TRAE 的注册表检测以 `DisplayIcon` 的文件名是否为 `Trae CN.exe` 为准，
  产品名只是次级判据，且严格等于合并版的 `Trae CN`。真实安装写入的 DisplayName
  是 `TRAE CN (User)`，装在非默认盘时只能靠 `DisplayIcon` 命中。放宽到裸 `TRAE`
  会同时命中同机的旧 `TraeWork CN` 工作区与 `TraeCode CN` 构建，选中就必然是错的、
  会破坏所有重启 TRAE 的流程。安装器与运行时必须用同一套判据，注册表预筛选也不得
  把真实条目挡在匹配之前。
- 卸载必须询问是否保留用户数据。`data\` 存放账号快照和 API token，删除它不可逆，
  绝不能隐式进行。

## 安装器不变式

- 安装器构建的安装是按用户的（`PrivilegesRequired=lowest`），位于
  `%LOCALAPPDATA%\Programs`，目录页已启用，因此可以修改位置。
- 所选 TRAE 路径通过
  `TraeMeta.exe configure --trae-exe <path>` 持久化，该命令在写入
  `data/config.json` 前会验证文件是否存在。
- 安装器必须在删除文件前移除登录自启动并停止服务（`[UninstallRun]`），否则会留下
  一个从已删除目录运行的监督进程。
- 重装和升级必须在替换文件前停止旧的已安装服务。必须保留稳定的 Inno `AppId`、
  上一应用目录以及上一任务选择，让账号数据和自启动偏好跨升级存活。
- 交互式卸载询问是否保留 `data\`；静默卸载必须默认保留，并且绝不阻塞在消息框上。


## 诊断不变式

- 守护进程通过 `redactLogLine` 写 `logs/daemon.log`。令牌形态（JWT、授权头、
  具名的密钥赋值、长十六进制串、密钥查询值）必须无法被持久化，因此每一行都
  应用脱敏。
- 守护进程日志写入刻意用同步方式：崩溃前立即写下的那一行最有价值，
  异步队列会丢掉它。
- 绝不能再丢弃守护进程输出。以 `stdio: "ignore"` 且无日志文件的方式运行它在
  用户机器上不留下任何证据，让每个失败都无法证伪。
- 传输失败必须报告其 `cause` 链。Node 把真实原因（`ECONNREFUSED`、`ENOTFOUND`、
  证书错误）藏在 `error.cause` 里，因此裸的 `fetch failed` 不是可接受的消息。
- 进入消息或日志的 URL 必须走 `redactUrl`：签到状态查询携带 `did`，它是个账号标识。
- 代理不再走子进程环境变量那一套。出网唯一咽喉是 `src/lib/http.js` 的 `requestJson`，
  它按目标 URL 向 `src/lib/proxy-runtime.js` 取 dispatcher；指向 `127.0.0.1` 的请求
  以及例外地址始终直连。
- `stripProxyEnv` 仍然保留：继承来的 `HTTP_PROXY` 会是一次面板既解释不了、也关不掉的
  代理决定，因此能触网的子进程仍必须剥离它。
- `service net` 只读取注册表以获知系统代理，绝不写入或修改 Windows 代理设置。

## 代理不变式

- `config.proxy` 是三态配置：`off`（默认）/`system`/`custom`，没有 `env` 模式。
  只有 `custom` 才要求地址与端口。
- dispatcher 由 `src/lib/proxy-runtime.js` 持有并随保存热替换，保存即生效，不重启
  守护进程。构建 dispatcher 失败绝不静默退回直连：保留上一个可用 dispatcher，并在
  `reason`/`notes` 里说明原因，因为"我以为走了代理，其实是直连"要到泄漏才能发现。
- 凭据只作为结构化 options 传给 undici（SOCKS5 走 `{username, password}`，HTTP/HTTPS
  走 `proxy-authorization` 头），绝不拼进代理 URL。
- 按用户要求，代理账号密码明文存放在本机 `data/config.json`。它们绝不进入日志、渲染
  脚本或 `GET /api/settings` 的 `network` 快照——那里只有 `hasCredentials` 布尔。
- 系统代理快照来自注册表，进入面板前必须脱敏：`ProxyServer` 里嵌的 `user:pass@`
  由 `splitCredentials` 剥离成结构化字段，其余出现位置由 `redactProxyUrl` 处理。
- 例外地址（`noProxy`）由 `getDispatcherFor` 按主机名判断，恒含回环地址。undici 的
  `ProxyAgent` 没有 `noProxy` 选项，这层判断只能由本项目自己做。
- HTTP 代理默认走 CONNECT 隧道（undici 的 `proxyTunnel` 默认 true）；对 HTTPS 目标
  这是唯一正确形态。
- 信任内网证书只通过 `src/lib/system-ca.js` 把 Windows 证书存储里的根证书并入默认
  信任列表；绝不使用 `rejectUnauthorized: false` 或 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
- 面板的「测试连接」与 `service net` 共用同一条 dispatcher 判定：先直连探测、再走代理
  探测，最后只给一条结论。
- 命令行 `configure --proxy-*` 只写文件：面板保存立即生效，命令行写入需要重启守护进程
  后才会生效。

## TRAE 设置不变式

- TRAE 通过 `User/settings.json` 中的 `update.mode: "manual"` 关闭自我更新。
  这不是猜测：发布的构建在该分支上记录日志 `update#ctor - manual checks only;
  automatic updates are disabled by user preference` 且从不安排检查，而 `default`
  会每 `update.interval`（60）分钟安排一次。证据在
  `%APPDATA%\Trae CN\logs\<stamp>\main.log`。
- `update.enableWindowsBackgroundUpdates` 已经默认为 false，本构建中
  `extensions.autoUpdate` 不存在。不要添加不产生任何改变的设置。
- 该文件是 JSONC。通过 `src/lib/trae-settings.js` 以文本方式编辑——只定向拼接一个
  值——绝不采用解析后再序列化，那会删除注释并重新格式化 TRAE 或用户放进去的内容。
- 之前的记录保存在 `data/config.json`（`traeUpdate.previousMode`），因此
  "允许自动更新" 恢复的是原来的值，而不是假定该项缺失。
- 首次写入前，该文件被复制为 `settings.json.traemeta.bak`，写失败时恢复。
  半写状态的设置文件必须不可能出现。
- 重复写同样的值不会产生写入，因此守护进程重启不会反复触碰 TRAE 的设置文件。
- 此处的改动在 TRAE 下次启动时生效。绝不要把它说成即时生效。
- 服务器下发的 `forceUpdate` 不在范围内：TRAE 自身的远程配置仍可能要求更新，
  假装不会就是虚假承诺。

## 助手自更新不变式

- 检查更新只读 `api.github.com/repos/<repo>/releases/latest`，并且永远只是提示。
  只有用户点「立即升级」才会下载和安装；后台检查绝不会自行下载，更不会安装。
- 升级包按文件名精确匹配 `TraeMeta-Setup-<version>.exe`。必须 `state=uploaded`、
  `size` 为正整数、`digest` 以 `sha256:` 开头、下载地址在 `github.com`。任一不满足
  就带着"缺哪一项"的理由拒绝，绝不降级为跳过校验照下。
- 校验用 asset 自带的 `digest`，不再下载 `SHA256SUMS.txt`：先比字节数、再比 sha256。
  任一不符立即删除下载文件并报错，绝不把没通过校验的文件交给安装程序。
- 下载走 `src/lib/http.js` 的 `downloadToFile`，与 `requestJson` 共用同一套
  dispatcher 判定，因此配了代理也不会被这条二进制请求绕开。它边写边算 sha256，
  所有失败路径都删除半成品，`maxBytes` 让超大的文件在写盘途中就被中止。
- 下载落在 `%LOCALAPPDATA%\Temp\TraeMeta-Update\`，绝不进 `data\`。安装程序会
  杀掉下载它的守护进程，所以临时文件不能在进程内清理：改为下次守护进程启动时扫
  一遍（`cleanupInstallerDirectory`）。删除失败只记日志不报错——正在运行的那个
  安装程序通常正锁着它。
- 拉起安装程序用分离式 spawn，**不带任何命令行开关**，并且先回响应、再延迟拉起：
  响应必须赶在安装程序把端口拿走之前到达面板。校验通过后弹出的是 Inno 自己的
  向导窗口，正是用户在等的东西；让向导照常跑也意味着失败会是一个看得见的对话框，
  而不是静默退出。绝不加回 `/VERYSILENT`。`launchInstaller` 返回子进程对象而非 pid，
  因为调用方必须能监听它的 `exit`（见下面 `installHandedOff` 那条）。
- 拉起安装程序时**绝不设置 `windowsHide`**。那是一个 `STARTUPINFO` 的 `SW_HIDE`
  提示，而安装程序是 GUI 程序，它创建的第一个窗口就是我们要给用户看的向导；
  藏掉它和「升级悄无声息地什么都没做」在用户眼里完全一样。安装程序也没有控制台
  需要隐藏。`test/app-installer.test.js` 会断言这一项为 `undefined`。
- 向导不会浮到 TRAE 前面，这是 Windows 前台锁而不是 bug：只有拥有前台窗口的进程
  才能把前台交出去，后台服务拉起的向导只能闪任务栏。面板在 `installing` 阶段必须
  写明"向导可能不在最前面，请到任务栏找「Trae Meta 安装」"，
  否则用户会以为升级什么都没做，然后再点一次「立即升级」。
- `PrepareToInstall` 会停掉旧服务，所以任何覆盖安装都必须在 `ssPostInstall` 里补
  一次 `daemon`——静默时 `[Run]` 整段被跳过，交互时结束页的勾选框也可能被取消，
  两者都不能依赖。重复调用是安全的（`daemon` 子命令先探健康检查）。
- 面板必须为安装进度推送 `traemeta:update-progress`，并在打开时从
  `GET /api/update` 的 `install` 字段恢复。下载在用户那一次请求里完成，请求会一直
  挂着，只靠它的返回值面板只能显示一行冻结的文案。进度按整 5% 节流。
- 面板只在守护进程仍认得升级的 `downloading`/`verifying`/`installing` 三个阶段从
  `install` 恢复，`failed` 与 `cancelled` 不恢复：后两者已经对用户说过一次，每次
  打开都回来会像是一次新的失败。
- 恢复只允许发生在**刚从网络取回的载荷**上（`renderAppUpdate(update, { fresh: true })`）。
  面板重绘自己手里的那份快照——推送之后、关闭进度框之后——绝不能恢复任何阶段：
  那份快照是 `/api/update` 在更早某个时刻说过的话，拿它恢复正是"失败的下载又弹出
  来并永远停在 1%"的成因。守护进程自己的阶段另存于 `appUpdateStage`，进度框可以被
  关掉，它不可以，因此「重试」这个标签在用户关掉失败框之后仍然成立。
- 失败的文案分两层：`message` 保留完整错误链只进 `logs/daemon.log`，`userMessage`
  是人话，进面板推送与 500 响应。面板里绝不出现 `UND_ERR_BODY_TIMEOUT` 这类套接字
  级事实——用户能对它做的只有检查网络或代理，那也正是人话要说的。判定超时必须走
  `isTimeoutError`（`src/lib/net-diagnostics.js`）沿 `cause` 链找 `AbortError` 与
  `UND_ERR_*_TIMEOUT`，因为 undici 自己的超时是普通错误而不是 abort。
- `downloadToFile` 必须把 undici 的 `headersTimeout`/`bodyTimeout` 显式对齐到调用方
  的预算。它们默认 300 秒，曾比 10 分钟的下载预算更早生效，于是"谁掐死了下载"有
  两处定义，而生效的那一处是没人读过的默认值。
- 已校验的安装包在临时目录里若仍与发布信息逐字节相符（先比大小、再比 sha256），
  重试时必须直接复用（`prepareInstaller`），不得重新下载：用户取消向导并没有消耗
  那个文件，再等一遍纯属白等。校验失败或文件不存在才下载。复用对用户是透明的。
- 安装失败只显示原因与「重试」，面板里永远不出现 GitHub 外链。
- 升级的互斥槽必须一直关到安装程序交出结果为止：`installInFlight` 只是那次下载
  请求，它在 200 响应发出时就归零，而向导要活得比响应更久（响应必须先到，向导才
  能停掉本进程）。因此守护进程另有一个 `installHandedOff`，从"准备拉起向导"那一刻
  置位，`isInstallBusy()` 同时看两者。少了它，用户在向导已弹出时再点一次「立即升级」
  会被放行并真的开始第二次下载——那次下载的目标正是向导正在运行的同一个 exe。
- `installHandedOff` 只在一种情况下释放：向导进程退出而本进程仍然活着。Inno 在替换
  任何一个文件之前就会停掉服务，所以这种情况只可能是用户关掉了向导、或向导根本没
  起来，升级并没有发生。此时才把状态推成 `cancelled`（不是 `idle`，`idle` 是刚启动
  的守护进程也会报的阶段，面板刻意忽略它）并放开按钮。
- 升级在进行中就是进行中，不是失败：`isInstallBusy()` 的 409 带
  `code: "install-in-flight"`，面板据此继续显示进度而不是报「安装失败」+「重试」。
  面板收到它时必须先丢掉自己那个乐观的「正在下载 0%」，再从 `GET /api/update`
  读回守护进程的真实阶段——否则被拒绝的第二次点击会留下一个假的下载框。
  另一条 409 是账号互斥（`code: "account-busy"`），必须区分开。安装程序杀进程导致
  面板断连是正常结局，必须给容错文案而不是报错。
- 安装失败只显示原因与「重试」，面板里永远不出现 GitHub 外链。
- 升级与签到、续签、切换、登录共用同一把互斥锁（`isInstallBusy()` 与既有各标志
  互相判断）：升级结束时守护进程会停止，绝不允许它截断一个进行中的账号操作。

## 工作流

- 每个提交必须代表一个完整的、用户确认的功能。
- 在用户测试并确认该功能之前不要提交。
- 未经用户明确批准绝不提交。
- 为存储校验、账号身份和切换回滚添加聚焦的测试。
- 在请求确认前运行 `npm test` 和 `npm run check`。
- `npm run check` 会自动遍历 `src/` 和 `scripts/`，所以新文件无需编辑文件列表
  即被覆盖。
- 在结果经由代码、测试或真实的回环/远程 API 复现之前，不要把它描述为已实现或已验证。
