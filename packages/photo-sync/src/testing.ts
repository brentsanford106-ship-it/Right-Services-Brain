import { webcrypto } from "node:crypto";
import type { BlobStore, Cipher } from "./vault";

/** In-memory file store for tests. */
export class MemoryBlobStore implements BlobStore {
  readonly files = new Map<string, Uint8Array>();
  async read(name: string) {
    const f = this.files.get(name);
    return f ? new Uint8Array(f) : null;
  }
  async write(name: string, data: Uint8Array) {
    this.files.set(name, new Uint8Array(data));
  }
  async remove(name: string) {
    this.files.delete(name);
  }
  async list() {
    return [...this.files.keys()];
  }
  async removeAll() {
    this.files.clear();
  }
}

/**
 * AES-256-GCM using the standard Web Crypto API (Node, browsers). Output format matches the
 * phone's expo-crypto "combined" form: 12-byte nonce || ciphertext || 16-byte tag.
 */
export class WebCryptoCipher implements Cipher {
  private constructor(private readonly key: webcrypto.CryptoKey) {}

  static async create(rawKey?: Uint8Array): Promise<WebCryptoCipher> {
    const raw = rawKey ?? webcrypto.getRandomValues(new Uint8Array(32));
    const key = await webcrypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt", "decrypt"]);
    return new WebCryptoCipher(key);
  }

  async seal(plaintext: Uint8Array, aad: string): Promise<Uint8Array> {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad), tagLength: 128 }, this.key, plaintext as Uint8Array<ArrayBuffer>),
    );
    const out = new Uint8Array(12 + ct.length);
    out.set(iv, 0);
    out.set(ct, 12);
    return out;
  }

  async open(sealed: Uint8Array, aad: string): Promise<Uint8Array> {
    if (sealed.length < 28) throw new Error("ciphertext too short");
    return new Uint8Array(
      await webcrypto.subtle.decrypt(
        { name: "AES-GCM", iv: sealed.subarray(0, 12), additionalData: new TextEncoder().encode(aad), tagLength: 128 },
        this.key,
        sealed.subarray(12) as Uint8Array<ArrayBuffer>,
      ),
    );
  }
}
