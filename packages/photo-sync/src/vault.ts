/**
 * Encrypted on-device storage for photos that have not reached the server yet.
 *
 * Everything written through the vault (image bytes, thumbnails, and each photo's
 * details such as job, note and GPS) is encrypted with AES-256-GCM before it touches
 * the disk. The key never leaves the platform's secure key store (iOS Keychain on the
 * phone). The file name is bound into each ciphertext as "additional data", so a file
 * cannot be swapped for another photo's file without the decryption failing.
 *
 * Platform code supplies the two adapters below; this module has no platform imports
 * so the same logic runs in the iPhone app and in automated tests.
 */

/** Raw file storage in the app's private folder. Implementations must make `write` atomic (write temp file, then rename). */
export interface BlobStore {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, data: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
  list(): Promise<string[]>;
  removeAll(): Promise<void>;
}

/** Authenticated encryption. `open` must throw if the data or `aad` was changed. */
export interface Cipher {
  seal(plaintext: Uint8Array, aad: string): Promise<Uint8Array>;
  open(sealed: Uint8Array, aad: string): Promise<Uint8Array>;
  /** Optional fast path for showing an image: decrypt straight to base64 in native code. */
  openBase64?(sealed: Uint8Array, aad: string): Promise<string>;
}

export class VaultLockedError extends Error {
  constructor(message = "The offline photo store could not be decrypted on this device.") {
    super(message);
    this.name = "VaultLockedError";
  }
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,120}$/;
const enc = new TextEncoder();
const dec = new TextDecoder();

export class Vault {
  constructor(private readonly store: BlobStore, private readonly cipher: Cipher) {}

  private check(name: string): void {
    if (!NAME.test(name)) throw new Error(`invalid vault file name: ${name}`);
  }

  async putBytes(name: string, data: Uint8Array): Promise<void> {
    this.check(name);
    await this.store.write(name, await this.cipher.seal(data, `rsb-vault-v1:${name}`));
  }

  async getBytes(name: string): Promise<Uint8Array | null> {
    this.check(name);
    const sealed = await this.store.read(name);
    if (!sealed) return null;
    try {
      return await this.cipher.open(sealed, `rsb-vault-v1:${name}`);
    } catch {
      throw new VaultLockedError(`Stored file "${name}" could not be decrypted (wrong key or damaged file).`);
    }
  }

  /** Decrypts to base64 (for displaying an image without writing it to disk unencrypted). */
  async getBase64(name: string): Promise<string | null> {
    this.check(name);
    const sealed = await this.store.read(name);
    if (!sealed) return null;
    try {
      if (this.cipher.openBase64) return await this.cipher.openBase64(sealed, `rsb-vault-v1:${name}`);
      return toBase64(await this.cipher.open(sealed, `rsb-vault-v1:${name}`));
    } catch {
      throw new VaultLockedError(`Stored file "${name}" could not be decrypted (wrong key or damaged file).`);
    }
  }

  async putJson(name: string, value: unknown): Promise<void> {
    await this.putBytes(name, enc.encode(JSON.stringify(value)));
  }

  async getJson<T>(name: string): Promise<T | null> {
    const b = await this.getBytes(name);
    return b ? (JSON.parse(dec.decode(b)) as T) : null;
  }

  remove(name: string): Promise<void> {
    this.check(name);
    return this.store.remove(name);
  }

  list(): Promise<string[]> {
    return this.store.list();
  }

  /** Deletes every file. Used on sign-out and when an account is revoked. */
  wipe(): Promise<void> {
    return this.store.removeAll();
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  if (i < bytes.length) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : "=") + "=";
  }
  return out;
}
