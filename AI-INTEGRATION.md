# ChatGPT 订阅接入维护说明

核对日期：2026-10-05。此项目仅监听本机，不是部署在服务器上的多用户网站；代码仓库保持私有。

## 官方依据与资格

- [Quickstart](https://developers.openai.com/siwc/quickstart)：开源项目及获准私有客户端的订阅使用范围；身份权限与推理权限不同。
- [注册和登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)：独立应用名称、host ID、动态注册、PKCE、nonce、ID token 与实际授予权限。
- [账号与会话](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)：注册复用、刷新轮换、并发串行化、撤销和本机断开。
- [模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)：账号 models 数组及 slug、Responses HTTP/SSE。
- [预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)：store:false、stream:true、输入数组、可用参数和能力边界。
- [错误与恢复](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)：拒绝、缺少权限、账号资格、用量限制和终止性刷新错误。
- [申请入口](https://developers.openai.com/siwc/request-client-id)：接入意向申请。公开仓库不是本次修复的一部分。

使用者在本次会话确认私有客户端已获批。本机 settings 的 siwc_eligibility=approved_private 仅记录此声明，不代表程序替服务端核准资格；此设置不进入备份。新机器需要重新核实资格、授权。若批准要求另一个专门的客户端流程，应按批准材料调整，不能借用 pi、Codex 或别人的 client_id。

## 分层与独立身份

| 文件 | 职责 |
| --- | --- |
| server/ai-auth.ts | OAuth 回调、JWT 验证、实际 scope、独立账号注册、刷新、撤销 |
| server/ai-vault.ts | OS 保护的短密钥、AES-GCM 加密的 SQLite 凭据、跨进程锁和数据库原子提交 |
| server/ai-inference.ts | 账号模型目录、Responses 请求、严格流式完成判断 |
| server/ai-errors.ts | 脱敏阶段、HTTP 状态、错误码、请求 ID、中文建议 |
| server/ai.ts | 与平台配置连接，最小连接测试，业务 JSON 解析 |
| server/index.ts | 业务校验、建议确认、事务保存、版本冲突检查 |

首次注册用 dynamic_agent_client 入口和“昭濂个人成长平台”名称；仅使用回调签发的真实 client_id 换令牌。后续复用已验证账号注册。host ID 沿用本机 device_id 并以 urn:uuid: 发送。监听随机可用端口后才向网页提供授权链接，同一次授权的 redirect_uri 完全一致。授权码只在本机回调处理，不要求复制密码或令牌。可选 id_token_hint 不发送，避免令牌经过平台网页。

ID token 验证 OpenAI discovery 的 issuer / JWKS、RS256 签名、audience、exp、iat、sub、nonce；已有注册还比较身份。权限采用 token 响应的 scope。已登录但缺少直接订阅权限时保留登录并禁止推理，用户可以显式重新同意权限。

旧 pi 凭据条目及数据库路径保持原位，新实现不读取旧令牌。Windows 钥匙串单条记录存在容量上限，旧版将整组 JSON 令牌塞入一条记录有失败风险。新钥匙串仅保存 32 字节随机密钥，令牌集合经 AES-GCM 加密后保存在独立的 `auth/siwc.credentials.sqlite`；数据库提交负责原子更新。若早期新版曾生成 `.enc` 文件，会只读迁移其加密内容，原文件保留。密钥失效或密文损坏时报告存储错误，不覆盖旧凭据、不降级明文。refresh、登录保存、账号切换及断开使用同一个带心跳的跨进程锁。锁超时不抢占活跃持有者。实机测试发现 `%LOCALAPPDATA%` 目录中的重命名操作会返回 `EXDEV`，这是改用 SQLite 原子提交的直接原因。

## 使用和排错

1. 设置中登录，打开官方授权页面。回调仅显示收到信息，最终结果看平台。
2. 获取账号模型列表，选择模型。显示名称与请求标识分开，不猜模型名。
3. 主动发送少量额度的无隐私测试。已登录、实际授权、模型列表、完整推理分别判断。仅测试通过后才允许提交成长内容。
4. 测试失败时查看阶段、HTTP、错误码及请求 ID。网络/代理/证书问题不会清空注册；不自动重发推理。不要通过不断重新登录处理额度限制或能力不支持。
5. 确认保存失败时建议仍为 pending，所有行修改回滚；输入和建议可在页面“保留的输入与建议”重新查看。旧建议缺少版本或记录已改变时要求重新整理，不覆盖新数据。无效 AI JSON 的原始结果留在本机失败记录中，可查看或通过数据备份导出。
6. 断开时尝试撤销远程 renewable session，并清除本机令牌，保留独立注册。未确认远程撤销时到 ChatGPT 设置断开应用。
   第 3 版成长备份保存事项版本号；第 1、2 版恢复时版本从 0 开始。
7. /api/health 返回 integration、buildId、startedAt，可与 dist/build-info.json 核对。构建不会自动重启已运行进程。网页与 API 发送 no-store，避免旧页面被浏览器缓存。

凭据、host ID、资格配置、模型配置及脱敏诊断不进入成长数据备份。换机器恢复成长备份后重新授权，不复制其他程序的登录信息。

## 验证范围

自动测试使用合成账号、RSA 签名及令牌，验证 PKCE 回调契约、篡改身份、拒绝、取消、超时、资格门槛、缺少 scope、额度不足、断网、刷新轮换、模型目录协议、失败/未完成/截断事件流、钥匙串大记录限制的规避，以及跨进程写入。业务测试验证事务保存失败、版本冲突、null 新建 ID 与无效更新 ID、进度撤销与旧备份恢复。Chrome 测试覆盖设置页、资格提示和窄窗口布局。

这些测试不能证明真实账号符合资格或订阅调用可用。真实验证必须由使用者完成官方浏览器授权并主动触发测试；随后应重启服务，核实加密凭据恢复和后续调用。界面保存的验证时间是历史成功记录，不是服务可用性保证。
