# ReadX macOS

与 Windows 使用相同的 React 阅读器、Go API、SQLite 迁移、Electron 主进程及 Lee OCR / 翻译 / 排版流水线。macOS 独立维护运行时安装、图标、签名和打包配置。

## 开发与启动

需要 Node.js 22.8+、Go 1.27+、uv。Apple Silicon 和 Intel 分别在对应架构的 Mac 上构建。

```sh
cd macos
npm ci
npm run setup:runtime
npm run check:runtime
npm start
```

也可双击 `启动 ReadX.command`。`npm start` 检查源码指纹后构建并启动；`npm run dev` 启动 Go、Vite 和 Electron 开发环境。设置 `CBCT_V2_GO` 可指定 Go，`READX_UV` 可指定 uv。

`setup:runtime` 安装工程内的 Python 3.12.14、预编译 PDF 依赖和 SHA-256 校验的 Typst 0.15.1。无需单独启动翻译引擎桌面端、Rust API 或任务服务。

## 功能与架构

同步书库、PDF / EPUB 阅读、目录、选区批注、阅读位置恢复、AI 助教多会话、模型与推理强度选择、精读五重奏、图表校正、重新翻译、任务进度、译文 PDF 阅读和导出。PPT 工作区先通读全文，结合已保存的精读记录生成可编辑 16:9 演示稿；支持重点解读、对比、流程、图文证据、数据聚焦与核心观点六种版式，预览与导出共用布局，原图等比嵌入正文、宽表和长内容自动分页。中英文使用微软雅黑，数字使用 Times New Roman。页面规划使用 ReadX 内置的 `baoyu-slide-deck` skill 规划页面，并由本地 PPTX 引擎渲染；skill 经 ReadX 统一 AI 接口调用，不依赖具体模型提供商的原生 skill 支持。

以上阅读、批注、AI 助教、精读、导入与翻译功能和 Windows 版共用核心实现。Windows 功能指南中的交互与功能说明同样适用于 macOS；只有明确标注的 Windows 快捷方式、目录和系统集成例外。

PDF 导入统一运行：Go 接收文件 → Lee Python provider-case → PaddleOCR → document.v1 → 翻译 / 质检 / 修复 → RPR 排版 → 回填文库。必须配置 PaddleOCR 和可用的 AI 渠道；仅配置 OCR 不能完成全文翻译。文件、任务限制与 Windows 相同。EPUB 使用相同的安全章节导入路径。

PDF 入库时统一联网检索 OpenAlex / Crossref，再由所选 AI 助手核对并补齐缺失的期刊/会议与年份。重复导入缺少出版信息的旧论文会复用正文补齐题录。阅读器支持原 PDF 内置引用跳转、无链接方括号编号定位及返回正文；引用导出与引用关系窗口使用更大的字号并显示完整标题。

AI 渠道包括 OpenAI 兼容 API、Anthropic、Codex Desktop / CLI、Claude CLI、Kimi CLI。macOS 会查找 `/Applications` 和 `~/Applications` 中的 Codex.app 与 ChatGPT.app 内置 CLI，以及常见的 Homebrew 和用户 CLI 安装目录；也可用 `CBCT_CODEX_PATH` 指定。不读取登录令牌文件。

具体交互见 [Windows 功能指南](../windows/README.md)。平台安装以本文为准。

## OCR 服务选择

在「AI 助手设置 → 文档识别」选择 **PaddleOCR** 或 **MinerU**，填写对应服务的访问令牌，再点击「保存 OCR 设置」。两家服务的地址、模型和令牌分别保存在本机配置中，切换时不会混用。

MinerU 接入[官方远程解析 API](https://mineru.net/apiManage/docs)，支持 `vlm` 和 `pipeline` 模型，每份 PDF 最多 200 MB、200 页。导入、重新识别和阅读器的 OCR 版式回填均使用所选服务；后续翻译和 PDF 排版沿用 Lee 引擎。

## LaTeX 写作与对话确认

顶栏「LaTeX Studio」支持新建项目、导入 Overleaf ZIP、编辑 `.tex` / `.bib` 和预览本机 TeX 编译的 PDF，需要先安装可用的 TeX 发行版。

在助手中直接发送修改要求，AI 会结合当前编辑内容和项目源码，在对应回复下显示文件修改卡片。可展开查看修改前后内容，点「确认修改」后创建快照并保存，点「取消修改」保留原文件；每张卡片修改一个文件。输入栏显示「请求批准」，聊天修改逐次确认，不需要开启自动修复写入。

LaTeX 可跟随全局模型，或在「模型设置」中指定自己的 HTTP 渠道、搜索选择模型及推理强度。目录可拖宽、诊断列表可隐藏，编译修复与源码快照默认折叠。自动修复编译错误另有「自动修复写入」开关，并会在错误未减少时回滚。项目文件和编译产物在本机；使用 AI 时，相关源码上下文会发送给所选模型服务。

![LaTeX 对话中的修改确认卡片与「请求批准」入口](../docs/images/promo/16-latex-chat-approval.png)

## 摸鱼界面

点击顶部挂件，以淡绿色漫画窗帘切换科研与摸鱼界面，采用平涂、描边褶皱、扇形帘头和少量网点；挂件可沿顶部拖动并记住位置。`Ctrl+Shift+M` 切换界面，摸鱼界面按 `Esc` 返回科研工作区。

<p align="center">
  <img src="../docs/images/promo/17-leisure-curtain.png" alt="淡绿色漫画窗帘转场截图（Windows 本地预览）" width="48%">
  <img src="../docs/images/promo/18-leisure-shelf.png" alt="摸鱼书架与 Qwen 拉绳挂件截图（Windows 本地预览）" width="48%">
</p>

以上为 Windows 本地预览截图，两平台共用这套界面设计。挂件入口借鉴 [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)，Qwen 图片取自该插件的 `ROPE_IMG_QWEN`；上游为 AI 娘二创形象署名 [ZipZipPipe](https://space.bilibili.com/4168597)。ReadX 实现了双界面切换、拖动定位与漫画窗帘。完整来源和致谢见[主 README](../README.md#挂件来源与致谢)。

独立书架支持本地 TXT、EPUB、图片与 CBZ。找书入口可搜索 Project Gutenberg 英文公版书并将下载内容加入书架；中文连载可导入兼容的 Legado 书源 JSON，按需获取和缓存章节。阅读数据保存在本机浏览器，在线检索和章节获取需要网络及可用书源。

统一书源支持官方 OPDS 目录、Z-Library 非官方 EAPI、本地导入和书源状态，详情展示格式与权利；下载支持进度、取消、重试、SHA-256 校验及导入后直接阅读，重复内容保留原进度。Z-Library 需在界面中配置服务地址并连接自己的账号或会话，逐书确认权限后按账号额度下载 EPUB/TXT；会话不写磁盘，重启后需重新连接。[接口、范围和测试说明](../docs/book-sources.md)。

## 数据与故障恢复

开发桌面版和打包版默认共用 `~/Library/Application Support/ReadX/`：

- `library/`：文献和译文 PDF。
- `app/data/v2/reader.db`：SQLite。
- `app/config.json`：AI / OCR 配置，令牌不回传前端。
- `app/logs/desktop.log`：异常退出与重启记录。

`CBCT_DATA_ROOT` 可指定其他数据根。服务仅绑定回环地址并校验 Bearer Token。正常退出先标记停机，再关闭后端；意外退出一分钟内最多重启三次，沿用原端口和 Token。中断的请求可能失败，需要用户重试，不会自动重放模型或导入请求。

## 保持双端一致

核心实现以 `windows/` 为编辑入口，macOS 对应源码由同步脚本生成。新功能或修复应先合入 Windows 对应源码，再运行同步脚本更新 macOS；不要只修改 macOS 的受管源码。macOS 独有的启动器、运行时安装、图标、签名和打包配置仍在 `macos/` 单独维护。

```sh
# 在仓库根目录
node scripts/sync-platforms.mjs
node scripts/sync-platforms.mjs --check
```

同步范围包含 server、web、shared、desktop/src、第三方源码、字体和渲染资源及公共构建 / 测试脚本。两端独立安装依赖和生成构建产物。完整边界见 [架构说明](../docs/architecture.md)。

## 验证

```sh
npm test
npm run build
npm run check:runtime
npm run test:import
npm run test:updates
npm run test:desktop
```

Go 测试含模拟 OCR / 模型与真实 Python / PDF 渲染集成；自动注入工程内 Python / Typst 路径。导入组件测试需要 Chrome / Edge，或设置 `CBCT_SMOKE_BROWSER`。桌面测试使用合成 PDF 和隔离书库，验证真实 Electron、preload、后端、鉴权、阅读器、位置保存、强制终止后的恢复及 Dock 重开，不调用付费模型。

这些检查不能替代真实论文与真实模型的质量验收。复杂表格、公式和多栏扫描件仍需人工对照。

## 打包

```sh
npm run build:release
npm run test:packaged
# 可选联网验证：真实更新源、并发 IPC 检查与版本号
node scripts/packaged-smoke.mjs --check-updates
```

产物位于 `release/`：当前架构的 ReadX.app、DMG 和更新用 ZIP。包内包含 Go、React、Python 及依赖、Typst、Lee 引擎、Node 渲染依赖和字体。普通用户不需要开发工具，OCR 与云端模型仍需联网。

macOS 构建显式使用 ad-hoc 临时签名，并强制完成签名，避免修改 Electron 应用资源后遗留无效的原签名。安装包测试会执行 `codesign --verify --deep --strict` 校验资源完整性。这不代表拥有 Apple Developer ID 签名或已通过公证、Gatekeeper。仓库的 `build-macos.yml` 在 macOS runner 上构建 DMG、ZIP、blockmap 和 `latest-mac.yml`，并在推送 `macos-vX.Y.Z` 标签后上传到同版本的 GitHub Release；Windows 安装包由 `vX.Y.Z` 标签对应的 Release workflow 构建。

macOS 应用内更新使用 **DMG 覆盖安装**，不再调用要求正式签名的 Squirrel「重启并安装」。检查更新会读取最近 100 个公开 Release，选择当前架构（arm64 / x64，或 universal）的最新正式 DMG，跳过 Windows 独占版本、草稿和预发布，且不允许降级。下载时校验 GitHub 资产元数据中的文件大小与 SHA-256；API 限流时改用公开的最新正式发行重定向和 latest-mac.yml 中的 SHA-512。打开安装包前再次核验；缺少校验信息或校验失败会阻止安装。下载完成点击「打开安装包」，先保存工作并退出 ReadX，再将 DMG 中的新版 ReadX 拖入 Applications 覆盖，重新打开应用。首次启动的 Gatekeeper 检查仍按系统策略处理。

### 首次启动被 macOS 拦截

先将 `ReadX.app` 拖到“应用程序”文件夹，再在“终端”中依次执行：

```sh
sudo spctl --master-disable
xattr -cr /Applications/ReadX.app
```

第一条命令会全局关闭 Gatekeeper，降低系统对所有应用的安全检查。请仅对可信来源且已确认的 ReadX 安装包执行；打开 ReadX 后，建议运行 `sudo spctl --master-enable` 恢复 Gatekeeper。输入 `sudo` 密码时，终端不会显示字符。

打包测试使用独立书库与 Electron 配置目录，不操作日常书库。CI 使用完整 ZIP 打包，拒绝缺少 `app-update.yml` 的应用目录。

本机构建不会创建线上更新。没有对应架构的正式 DMG 时会明确提示暂无安装包，不会把 Windows 的版本当作 macOS 可安装更新。更新测试覆盖版本与架构选择、防降级、下载完整性、损坏缓存、打开失败重试、并发及界面提示。旧版客户端所需的 ZIP 和 `latest-mac.yml` 仍保留在发行产物中。

### LaTeX 实时预览

LaTeX Studio 工具栏新增“实时预览”，基于 [realtime-tex（rtex）](https://github.com/HenryXiaoYang/realtime-tex) v0.0.5。项目需要使用 LuaLaTeX；其他引擎的项目可在面板内切换。首次预览会排版整篇文档，后续正文改动直接更新段落，分页、引用和复杂图形由后台整页排版更新。面板显示段落耗时、整页同步状态和可跳转的 LaTeX 诊断；复杂页面使用 PDF 回退并标明状态。

本机需要 MiKTeX 或 TeX Live 中的 LuaLaTeX。面板可下载并安装官方 rtex 发行版，安装前校验固定 SHA-256，运行时位于 `<数据根>/app/runtime/rtex/0.0.5/`。自定义安装可设置 `READX_RTEX_BIN` 指向 `rtex` 可执行文件，并保留发行包的 `share/rtex/tex` 目录（也可设置 `RTEX_TEXDIR`）。打包时包含 Node 桥接程序和上游 MIT 许可证，rtex 引擎按需下载。普通编译及 PDF 导出仍通过现有编译功能使用。

### 仅保存原文

导入窗口提供「仅保存原文」，支持文件队列单篇及批量入库，无需 AI / OCR 配置，不调用在线识别、翻译或题录服务。无已有题录时暂用文件名；入库后可阅读原文、批注。扫描件不自动识别，配置服务后可在阅读器中使用「重新翻译」补处理。

### 完整备份与恢复（开发中）

书库同步设置中新增「创建完整备份」和「从备份恢复」。操作确认后关闭应用，完成后自动重启；同时保存数据目录与桌面本地存储，恢复前校验文件并保留原目录检查点。详见[备份与恢复说明](../docs/backup-and-restore.md)。

## 外部集成开发版（2026-11-05）

AI 设置支持按整库、书架、论文和 LaTeX 项目控制发送；备份恢复后重新确认许可。导入窗口支持浏览器采集、跨页多源检索、引文发现路径和 Zotero 个人库迁移／双向核对；书库提供包含 EPUB 上下文、研究想法及对照数据的只读 HTML 分享。浏览器扩展需手动加载本目录 `browser-extension/`。Zotero 采用明确触发、逐对象确认的核对方式，不自动传播删除或覆盖原文件；部分原生坐标仅保留原始数据。

最新范围、测试和实机验收限制见[追加交付记录](../docs/外部集成剩余工作交付-2026-11-05.md)。首版历史见[首版交付记录](../docs/外部集成六项首版交付-2026-11-05.md)。可运行 `npm run test:external` 验证新增接口和前端授权逻辑。
