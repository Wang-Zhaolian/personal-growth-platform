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

`npm run typecheck` 检查 TypeScript；`npm run test:progress` 验证期限、进度、撤销和备份恢复；Windows 上安装了 Chrome 时，`npm run test:browser` 会检查品牌、授权网络状态、进行中进度卡片和 390px 窄屏布局。集成检查使用临时数据库，不修改个人数据。

## AI 模型

打开左下角“设置”，选择“使用 ChatGPT 登录”，按网页提示完成 OAuth 授权，然后选择模型并测试连接。授权和模型调用都由本机服务经 `@earendil-works/pi-ai` 提供。平台先读取显式 HTTP/HTTPS 代理环境变量，其次读取 Windows 系统静态代理；本机接口不经代理。PAC 自动代理暂不支持，设置页会显示当前网络来源。实际模型接入以“测试模型调用”成功为准。

AI 建议只有在预览页确认后才写入成长记录或每日任务。成长事项和单日任务分别保存，勾选单日任务不会自动完成整项成长事项。

进行中事项需要截止日期和已确认进度；AI 可以依据你提供的里程碑提出估算，确认页会显示估算依据，确认前不会修改正式记录。

## 数据与迁移

- SQLite 数据库：`%LOCALAPPDATA%\个人成长平台\growth.db`
- 模型凭证：Windows 当前用户的操作系统钥匙串
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
