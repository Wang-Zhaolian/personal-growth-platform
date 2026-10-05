import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = join(projectRoot, 'node_modules', '@earendil-works', 'pi-ai', 'package.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
if (packageJson.version !== '1.0.2') throw new Error(`pi-ai callback patch expects 1.0.2, received ${packageJson.version}`);

const callbackPath = join(dirname(packagePath), 'dist', 'auth', 'oauth', 'openai-chatgpt.js');
const originalCall = 'sendHtml(response, 200, oauthSuccessHtml("ChatGPT authentication completed. You can close this window."));';
const patchedCall = `sendHtml(response, 200, '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>授权信息已收到</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f7fc;color:#173353;font:16px system-ui,"Microsoft YaHei",sans-serif;text-align:center}.card{max-width:520px;margin:24px;padding:40px;border:1px solid #e4ecf5;border-radius:18px;background:#fff;box-shadow:0 12px 36px #17335312}.mark{margin:0 auto 20px;width:58px;height:58px;display:grid;place-items:center;border-radius:18px;background:#eaf3ff;color:#3678d3;font-size:30px;font-weight:700}h1{font-size:26px;margin:0 0 12px}p{color:#73879d;line-height:1.8;margin:4px 0}</style></head><body><main class="card"><div class="mark">昭</div><h1>已收到授权回调</h1><p>平台正在校验并保存 ChatGPT 凭证。</p><p>请返回昭濂个人成长平台查看最终连接状态。</p></main></body></html>');`;

const source = readFileSync(callbackPath, 'utf8');
if (source.includes(patchedCall)) process.exit(0);
if (!source.includes(originalCall)) throw new Error('pi-ai callback template changed; refusing to apply an unverified patch.');
writeFileSync(callbackPath, source.replace(originalCall, patchedCall), 'utf8');
console.log('Patched the pi-ai ChatGPT callback page wording.');
