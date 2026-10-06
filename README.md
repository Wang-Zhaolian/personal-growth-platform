# 昭濂个人成长平台

一个在 Windows 本机运行的个人成长记录与每日计划工具。数据保存在 Windows 用户数据目录下的 SQLite 数据库；模型授权由操作系统钥匙串保护。

## 首次安装

需要 Node.js 22.19 或更新版本。双击 `setup.bat` 安装依赖、构建应用并创建桌面快捷方式。以后双击桌面上的 **“昭濂个人成长平台”** 即可打开网页。

也可以在项目目录运行：

```powershell
npm install
npm run build
npm run desktop
```

## 开发

```powershell
npm run dev
```

本地网页默认地址为 `http://127.0.0.1:5173`，接口服务监听 `127.0.0.1:4178`。

## 验证

`npm run typecheck` 检查 TypeScript；`npm run test:ai` 验证独立授权、签名、刷新、账号模型协议、流式完成与加密存储；`npm run test:progress` 验证期限、进度、撤销和备份恢复；`npm run test:features` 验证手动编辑、事项版本冲突、每日重规划、附件与备份隐私；Windows 上安装了 Chrome 时，`npm run test:browser` 检查品牌、授权网络状态、手动表单和窄屏布局。集成检查使用临时数据库，不修改个人数据，也不调用真实模型。

## AI 模型

本项目是 Windows 本机客户端，仓库保持私有。官方当前向开源项目及获准的私有客户端开放订阅额度流程，通常需要符合条件的 ChatGPT Plus / Pro 账号。私有项目应先取得 OpenAI 的批准；本机运行并不自动取得资格。本次使用者确认已获批，实际账号与权限仍由官方授权结果决定。新安装默认不启用，获批后可在启动环境中设置 GROWTH_SIWC_ELIGIBILITY=approved_private，或由维护者记录本机资格配置。不要把资格声明当成服务端批准。

设置页依次执行：Continue with ChatGPT → 打开官方授权页 → 返回平台 → 获取 / 刷新账号模型 → 选择模型 → “发送无隐私测试（少量额度）”。测试只请求 Hello, world!，明确收到完整 response.completed 且文本符合预期后才标记“已验证可调用”。模型变更后重新测试，再提交成长内容。AI 输入支持 PNG/JPG/WebP 图片、PDF、DOCX、TXT 和 Markdown 文件；每次最多 5 个文件、单个不超过 10 MiB、合计不超过 20 MiB。附件仅暂存在本机供待确认草稿重试，确认、忽略或恢复备份时清理原件；备份仅保留草稿文字及附件名称等元信息，不含附件原件。

平台直接按官方 SIWC 文档实现 Code + PKCE / state / nonce / ID token 签名校验，使用本应用真实名称及动态注册返回的独立 client_id。未使用 Codex 登录、浏览器 Cookie、API Key 或其他客户端身份。旧 pi 配置及凭据保持原位，不读取或迁移旧令牌；首次新版登录创建本应用自己的注册。多次登录复用已验证注册，可在设置中切换或添加独立注册。

账号模型列表来自 GET https://api.openai.com/v1/models 的 models 数组，展示 display_name、请求使用 slug。文本请求使用官方 Responses API，固定 store:false、stream:true；不添加预览流程不支持的参数。推理请求不自动重发，避免断流后的重复用量。撤销遇到临时失败最多重试一次，未确认远程撤销会明确提示。

网络优先读取 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY 环境变量，其次 Windows 已启用的静态系统代理；本机回调始终直连。PAC 不支持，TLS 校验保持开启。设置页显示网络来源与脱敏诊断。

技术细节、官方依据和排错见 [AI-INTEGRATION.md](AI-INTEGRATION.md)。

成长事项支持手动新增、编辑、移动状态、归档和恢复；手动保存不会调用 AI。AI 建议只有在预览页确认后才写入成长记录或每日任务。成长事项和单日任务分别保存，勾选单日任务不会自动完成整项成长事项。

进行中事项需要截止日期和已确认进度；AI 可以依据你提供的里程碑提出估算，确认页会显示估算依据，确认前不会修改正式记录。每日任务先设置时间预算，AI 参考进行中事项的截止紧迫度、优先级、进度和下一步列出任务与预计用时，不安排开始或结束时间；只有确认后才会建立或调整正式任务。此前 30 天的未完成任务只作为 AI 候选，不会自动出现在新日期；确认接续后原日期保留“已暂缓”历史，并在新任务卡片上标出来源。

## 数据与迁移

- SQLite 数据库：`%LOCALAPPDATA%\个人成长平台\growth.db`
- 模型凭证：用户数据目录 auth/siwc.credentials.sqlite（内部是 AES-256-GCM 密文），加密密钥由 Windows 当前用户系统钥匙串保护；不会以明文降级
- “设置 → 数据备份与迁移”导出或恢复 JSON 备份。恢复前程序会在本机数据目录留存一次安全备份。
- 代码由 Git／GitHub 保存；成长数据和模型凭证均不纳入代码仓库。换电脑时克隆代码、运行 `setup.bat`、恢复数据备份，再重新登录模型。

## GitHub

仓库建议设为私有。完成 Git 配置后，可以在此目录运行：

```powershell
git init
git add .
git commit -m "Build personal growth platform"
```

创建 GitHub 私有仓库后，将其设为 `origin` 并推送 `main` 分支。
