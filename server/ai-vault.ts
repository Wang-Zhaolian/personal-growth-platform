import { Entry } from '@napi-rs/keyring';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { AIError } from './ai-errors.js';

export type Registration = { key: string; clientId: string; subject?: string; label: string; accessToken?: string; refreshToken?: string; idToken?: string; scopes: string[]; expiresAt?: number; verified?: { model: string; at: string }; reauthRequired?: boolean };
export type VaultData = { active?: string; registrations: Registration[] };
export interface Vault { transact<T>(action: (data: VaultData, save: () => Promise<void>) => Promise<T>): Promise<T> }
// Tokens are encrypted as one atomic file. Only its small encryption key lives in
// the OS keyring; Windows Credential Manager's per-entry size limit cannot truncate JWTs.
export class ProtectedVault implements Vault {
  constructor(private directory: string, private keyService = 'PersonalGrowthPlatform') {}
  async transact<T>(action: (data: VaultData, save: () => Promise<void>) => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, 'siwc.credentials.enc');
    let release: (() => Promise<void>) | undefined;
    let compromised = false;
    try {
      release = await lockfile.lock(path, { realpath: false, stale: 180_000, update: 5000, retries: { retries: 120, minTimeout: 250, maxTimeout: 1000 }, onCompromised: () => { compromised = true; } });
      let encrypted: Buffer | undefined;
      try { encrypted = await readFile(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const entry = new Entry(this.keyService, 'siwc-encryption-key-v1');
      let key: Buffer | undefined;
      if (encrypted) {
        const secret = entry.getPassword();
        if (!secret) throw new Error('Missing encryption key');
        key = Buffer.from(secret, 'base64');
      }
      let data: VaultData = { registrations: [] };
      if (encrypted && key) {
        if (encrypted.subarray(0, 4).toString() !== 'SIW1') throw new Error('Invalid vault');
        const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(4, 16));
        decipher.setAuthTag(encrypted.subarray(16, 32));
        data = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]).toString('utf8'));
      }
      const save = async () => {
        if (compromised) throw new Error('Credential lock lost');
        if (!key) {
          const saved = entry.getPassword();
          key = saved ? Buffer.from(saved, 'base64') : randomBytes(32);
          if (!saved) entry.setPassword(key.toString('base64'));
        }
        const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
        const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
        const temporary = `${path}.${process.pid}.tmp`;
        try {
          await writeFile(temporary, Buffer.concat([Buffer.from('SIW1'), nonce, cipher.getAuthTag(), body]), { mode: 0o600 });
          if (compromised) throw new Error('Credential lock lost');
          await rename(temporary, path);
        } finally { await unlink(temporary).catch(() => {}); }
      };
      return await action(data, save);
    } catch (error) {
      if (error instanceof AIError) throw error;
      throw new AIError('数据保存', 'credential_storage_failed', '受保护的凭据存储不可用。', '检查系统钥匙串和用户数据目录权限。不会降级为明文，也不会覆盖旧凭据。');
    } finally { await release?.().catch(() => {}); }
  }
}
