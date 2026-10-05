import { spawnSync } from 'node:child_process';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

type ProxySource = 'environment' | 'windows' | 'direct' | 'unsupported-auto-config';
type ProxyRoute = { url?: string; error?: string };

function firstEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function normalizeProxy(value: string | undefined): ProxyRoute {
  if (!value) return {};
  const url = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error();
    return { url };
  } catch {
    return { error: '代理地址格式不正确，请检查系统代理或 HTTP_PROXY/HTTPS_PROXY 配置。' };
  }
}

function readWindowsProxy() {
  if (process.platform !== 'win32') return {};
  const result = spawnSync('reg.exe', [
    'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  ], { encoding: 'utf8', windowsHide: true });
  const output = result.stdout ?? '';
  const get = (name: string) => output.match(new RegExp(`\\s${name}\\s+REG_\\w+\\s+([^\\r\\n]+)`, 'i'))?.[1]?.trim();
  if (get('ProxyEnable')?.toLowerCase() !== '0x1') {
    return get('AutoConfigURL') ? { autoConfig: true } : {};
  }
  const server = get('ProxyServer');
  const overrides = get('ProxyOverride')?.split(';').map((host) => host.trim()).filter((host) => host && host !== '<local>').join(',');
  if (!server) return get('AutoConfigURL') ? { autoConfig: true } : {};
  const values = new Map<string, string>();
  if (server.includes('=')) {
    for (const part of server.split(';')) {
      const [key, ...rest] = part.split('=');
      if (rest.length && ['http', 'https'].includes(key.trim().toLowerCase())) values.set(key.trim().toLowerCase(), rest.join('=').trim());
    }
  } else {
    values.set('http', server);
    values.set('https', server);
  }
  return { http: values.get('http'), https: values.get('https'), noProxy: overrides, autoConfig: false };
}

const windows = readWindowsProxy();
const envHttp = firstEnv('HTTP_PROXY', 'http_proxy');
const envHttps = firstEnv('HTTPS_PROXY', 'https_proxy');
const envAll = firstEnv('ALL_PROXY', 'all_proxy');
const http = normalizeProxy(envHttp ?? envAll ?? windows.http);
const https = normalizeProxy(envHttps ?? envAll ?? windows.https ?? windows.http);
const source: ProxySource = envHttp || envHttps || envAll ? 'environment' : http.url || https.url ? 'windows' : windows.autoConfig ? 'unsupported-auto-config' : 'direct';
const noProxy = [firstEnv('NO_PROXY', 'no_proxy')?.replaceAll(';', ','), windows.noProxy, 'localhost,127.0.0.1,::1,[::1]']
  .filter(Boolean).join(',');

let configurationError = http.error ?? https.error;
if (!configurationError && source === 'unsupported-auto-config') {
  configurationError = '检测到 Windows 自动代理（PAC），但 Node 服务无法解析这项配置。请改用系统静态 HTTP/HTTPS 代理或代理环境变量后重试。';
}
if (!configurationError) {
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent({ httpProxy: http.url, httpsProxy: https.url, noProxy }));
  } catch {
    configurationError = '无法初始化当前代理配置，请检查代理地址后重启平台。';
  }
}

export function getOutboundNetworkStatus() {
  return {
    source: source === 'environment' ? '环境变量代理' : source === 'windows' ? 'Windows 系统代理' : source === 'direct' ? '直连' : 'Windows 自动代理',
    httpProxy: Boolean(http.url),
    httpsProxy: Boolean(https.url),
    ready: !configurationError,
    error: configurationError,
  };
}

export function assertOutboundNetworkReady() {
  if (configurationError) throw new Error(configurationError);
}

export function describeOutboundNetworkError(error: unknown) {
  if (configurationError) return configurationError;
  const status = getOutboundNetworkStatus();
  if (!status.httpProxy && !status.httpsProxy) return undefined;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current !== 'object') break;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(String(candidate.code ?? ''))) {
      return '无法连接已配置的系统代理，请检查代理是否正在运行后重试。';
    }
    current = candidate.cause;
  }
  return undefined;
}
