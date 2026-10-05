import { Entry } from '@napi-rs/keyring';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import lockfile from 'proper-lockfile';
import { AIError } from './ai-errors.js';

export type Registration = { key: string; clientId: string; subject?: string; label: string; accessToken?: string; refreshToken?: string; idToken?: string; scopes: string[]; expiresAt?: number; verified?: { model: string; at: string }; reauthRequired?: boolean };
export type VaultData = { active?: string; registrations: Registration[] };
export interface Vault { transact<T>(action: (data: VaultData, save: () => Promise<void>) => Promise<T>): Promise<T> }
// Windows Credential Manager has a short per-entry limit. Keep only a 32-byte key
// there; SQLite commits the AES-GCM ciphertext atomically on the local filesystem.
export class ProtectedVault implements Vault {
  constructor(private directory: string, private keyService = 'PersonalGrowthPlatform') {}
  async transact<T>(action: (data: VaultData, save: () => Promise<void>) => Promise<T>): Promise<T> {
    let storageStep = 'initialize';
    let release: (() => Promise<void>) | undefined;
    let database: Database.Database | undefined;
    let compromised = false;
    try {
      await mkdir(this.directory, { recursive: true });
      const path = join(this.directory, 'siwc.credentials.sqlite');
      storageStep = 'lock';
      release = await lockfile.lock(path, { realpath: false, stale: 180_000, update: 5000, retries: { retries: 120, minTimeout: 250, maxTimeout: 1000 }, onCompromised: () => { compromised = true; } });
      storageStep = 'open_database';
      database = new Database(path);
      database.pragma('journal_mode = WAL');
      database.exec('CREATE TABLE IF NOT EXISTS credential_blob (id INTEGER PRIMARY KEY CHECK(id=1), payload BLOB NOT NULL)');
      let encrypted = (database.prepare('SELECT payload FROM credential_blob WHERE id=1').get() as { payload: Buffer } | undefined)?.payload;
      // Compatibility with an earlier encrypted-file build, if one exists.
      if (!encrypted) {
        storageStep = 'read_legacy';
        try { encrypted = await readFile(join(this.directory, 'siwc.credentials.enc')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const entry = new Entry(this.keyService, 'siwc-encryption-key-v1');
      let key: Buffer | undefined;
      if (encrypted) {
        storageStep = 'read_key';
        const secret = entry.getPassword();
        if (!secret) throw new Error('Missing encryption key');
        key = Buffer.from(secret, 'base64');
      }
      let data: VaultData = { registrations: [] };
      if (encrypted && key) {
        storageStep = 'decrypt';
        if (encrypted.length < 33 || encrypted.subarray(0, 4).toString() !== 'SIW1') throw new Error('Invalid credential envelope');
        const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(4, 16));
        decipher.setAuthTag(encrypted.subarray(16, 32));
        data = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]).toString('utf8'));
      }
      const save = async () => {
        storageStep = 'lock_check';
        if (compromised) throw new Error('Credential lock lost');
        if (!key) {
          // No ciphertext exists, so an orphaned key from a failed attempt can
          // safely be replaced without affecting a credential record.
          storageStep = 'write_key';
          key = randomBytes(32);
          entry.setPassword(key.toString('base64'));
        }
        storageStep = 'encrypt';
        const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
        const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
        const envelope = Buffer.concat([Buffer.from('SIW1'), nonce, cipher.getAuthTag(), body]);
        if (compromised) throw new Error('Credential lock lost');
        storageStep = 'commit_database';
        database!.prepare('INSERT INTO credential_blob(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(envelope);
      };
      const result = await action(data, save);
      // A read-only access to a legacy record leaves it untouched. A later save
      // commits it to SQLite, while retaining the encrypted old file as backup.
      return result;
    } catch (error) {
      if (error instanceof AIError) throw error;
      const advice = storageStep === 'write_key' || storageStep === 'read_key' ? 'Windows 钥匙串无法保存或读取本应用的短加密密钥。请检查凭据管理器权限。' : storageStep === 'commit_database' || storageStep === 'open_database' ? '本机加密凭据数据库无法提交，请检查磁盘与目录权限。' : storageStep === 'decrypt' ? '加密凭据与系统钥匙串不匹配；原文件已保留，请勿直接删除。' : '请检查本机锁和用户数据目录权限，不会降级为明文。';
      throw new AIError('数据保存', `credential_${storageStep}_failed`, '受保护的凭据存储不可用。', advice);
    } finally {
      database?.close();
      await release?.().catch(() => {});
    }
  }
}
