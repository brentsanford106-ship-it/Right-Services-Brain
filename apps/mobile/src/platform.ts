/**
 * iPhone/iPad implementations of the storage and encryption adapters used by @rsb/photo-sync.
 *
 * - Files live in the app's private Documents folder under "vault/" (not visible in the Photos app or Files app).
 * - Every file is AES-256-GCM encrypted by iOS's own crypto (expo-crypto uses Apple CryptoKit).
 * - The 256-bit key is created on the phone and kept only in the iOS Keychain with
 *   "when unlocked, this device only": it is not included in iCloud or iTunes backups and
 *   can't be moved to another phone. Deleting the key makes the vault unreadable (crypto-shredding).
 */
import { Directory, File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { AESEncryptionKey, AESKeySize, AESSealedData, aesDecryptAsync, aesEncryptAsync } from "expo-crypto";
import type { BlobStore, Cipher } from "@rsb/photo-sync";

const KEY_NAME = "rsb.vault.key.v1";
const KEY_OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export class ExpoBlobStore implements BlobStore {
  private readonly dir = new Directory(Paths.document, "vault");

  private ensure(): void {
    if (!this.dir.exists) this.dir.create({ intermediates: true, idempotent: true });
  }

  async read(name: string): Promise<Uint8Array | null> {
    const f = new File(this.dir, name);
    if (!f.exists) return null;
    return f.bytes();
  }

  /** Atomic: write a temporary file, then rename over the old one. A crash never leaves half a file. */
  async write(name: string, data: Uint8Array): Promise<void> {
    this.ensure();
    const tmp = new File(this.dir, `${name}.tmp`);
    if (tmp.exists) tmp.delete();
    tmp.create();
    await tmp.write(data);
    await tmp.move(new File(this.dir, name), { overwrite: true });
  }

  async remove(name: string): Promise<void> {
    const f = new File(this.dir, name);
    if (f.exists) f.delete();
  }

  async list(): Promise<string[]> {
    if (!this.dir.exists) return [];
    const out: string[] = [];
    for (const item of this.dir.list()) {
      if (item instanceof File) {
        if (item.name.endsWith(".tmp")) item.delete(); // leftover from an interrupted write
        else out.push(item.name);
      }
    }
    return out;
  }

  async removeAll(): Promise<void> {
    if (this.dir.exists) this.dir.delete();
  }
}

export class ExpoCipher implements Cipher {
  private constructor(private readonly key: AESEncryptionKey) {}

  /** Loads the key from the Keychain, creating it the first time. */
  static async load(): Promise<ExpoCipher> {
    const stored = await SecureStore.getItemAsync(KEY_NAME, KEY_OPTS);
    if (stored) return new ExpoCipher(await AESEncryptionKey.import(stored, "base64"));
    const key = await AESEncryptionKey.generate(AESKeySize.AES256);
    await SecureStore.setItemAsync(KEY_NAME, await key.encoded("base64"), KEY_OPTS);
    return new ExpoCipher(key);
  }

  /** Sign-out / revocation: destroy the key. Anything left on disk can no longer be decrypted. */
  static async destroyKey(): Promise<void> {
    await SecureStore.deleteItemAsync(KEY_NAME, KEY_OPTS);
  }

  async seal(plaintext: Uint8Array, aad: string): Promise<Uint8Array> {
    const sealed = await aesEncryptAsync(plaintext, this.key, {
      nonce: { length: 12 },
      tagLength: 16,
      additionalData: new TextEncoder().encode(aad),
    });
    return sealed.combined("bytes");
  }

  async open(sealed: Uint8Array, aad: string): Promise<Uint8Array> {
    const data = AESSealedData.fromCombined(sealed, { ivLength: 12, tagLength: 16 });
    return aesDecryptAsync(data, this.key, { output: "bytes", additionalData: new TextEncoder().encode(aad) });
  }

  async openBase64(sealed: Uint8Array, aad: string): Promise<string> {
    const data = AESSealedData.fromCombined(sealed, { ivLength: 12, tagLength: 16 });
    return aesDecryptAsync(data, this.key, { output: "base64", additionalData: new TextEncoder().encode(aad) });
  }
}

/** Folder for short-lived unencrypted copies needed by the camera and the uploader. Emptied at every app start. */
export function scratchDir(): Directory {
  const d = new Directory(Paths.cache, "rsb-scratch");
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

export function clearScratch(): void {
  const d = new Directory(Paths.cache, "rsb-scratch");
  if (d.exists) d.delete();
}

export function deleteQuietly(uri: string | null | undefined): void {
  if (!uri) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // Already gone.
  }
}
