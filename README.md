# 个人成长平台

私人使用的中文成长记录工作台。四个入口是每日更新、已完成、进行中和待进行。正式记录、待确认草稿及变更历史保存在 Sites 的 D1 数据库中；源码保存在私有 GitHub 仓库。

## 日常使用

1. 在 ChatGPT 新对话中选择已连接的“个人成长平台”插件，叙述过去完成、当前推进或未来计划。插件先查询已有事项，再保存一份待确认草稿。
2. 打开插件提供的预览链接，在“每日更新”核对类别、时间、层级和状态。保存修改后，点击“确认写入记录”。保存草稿本身不会修改正式事项。
3. 如果 ChatGPT 暂时不可用，可直接在“每日更新”手动补录或更正。后三个页面只负责查看。
4. 每周在“每日更新 → 数据备份”下载 JSON 文件，并保存在自己控制的位置。备份中包含私人信息，请勿加入 Git 仓库。

## ChatGPT 插件连接

Sites 发布时启用 `mcp` 能力，并提供私有的 `/mcp` 服务。发布后在 Sites 提供的个人插件入口安装并授权，随后新建 ChatGPT 对话，通过 `@个人成长平台` 使用。网站本身不调用 OpenAI API，不需要 API key。插件只暴露 `search_records`、`get_draft`、`save_draft`；正式写入必须在网页确认。请勿把预览链接当成已完成更新。

## 本地开发

要求 Node.js 22.13+。依赖安装：`npm ci`。数据库结构定义在 `db/schema.ts`；更改后用 `npm run db:generate` 生成迁移。首次本地运行时，先 `npm run build`，再将 `drizzle/*.sql` 按顺序应用到本地 D1：

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_damp_inertia.sql
npm run dev
```

本地浏览器通过 `/signin-with-chatgpt?return_to=/` 进入测试登录。正式环境由 Sites 处理 ChatGPT 登录。项目目录中的 `.openai/hosting.json` 只保存逻辑绑定和站点标识，不包含凭据。

## 备份与迁移

网站的“下载 JSON 备份”包含事项、草稿和更新历史。恢复仅接受本平台版本 1 的备份，且目标数据库必须为空；不会覆盖已有数据。迁出 Sites 时，需另外设置认证、D1 兼容数据库及部署方式。GitHub 只保存程序，不会自动同步数据库中的个人记录。

## 验收重点

- 正式列表在草稿确认前保持不变；确认后事项保持同一 ID、版本和历史。
- 旧版本草稿或重复提交不能覆盖当前记录；跨电脑登录读取同一数据库。
- 除本人登录与授权外，不可读取私人记录；插件工具无法正式提交。
- 导出文件恢复到空数据库后，事项、层级、草稿和历史一致。
