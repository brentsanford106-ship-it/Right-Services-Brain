import { RestError, type ContainerClient } from "@azure/storage-blob";
import { assertValidKey, type ObjectStorage } from "./types.js";

/**
 * Production photo storage: one PRIVATE Azure Blob container.
 *
 * - The server signs in to storage with its own Azure identity (managed identity). There is no storage
 *   key or password anywhere, and the storage account has key access switched off (see infra/main.bicep).
 * - Nothing is public and no share links (SAS) are made: every photo download goes through the API,
 *   which checks company, job access and permission each time.
 * - Deleted blobs are kept by Azure for 30 days (soft delete) and every overwrite keeps the old version.
 */
export class AzureBlobStorage implements ObjectStorage {
  constructor(private readonly container: ContainerClient) {}

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    assertValidKey(key);
    await this.container.getBlockBlobClient(key).uploadData(data, {
      blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: "private, no-store" },
    });
  }

  async get(key: string): Promise<Buffer | null> {
    assertValidKey(key);
    try {
      return await this.container.getBlockBlobClient(key).downloadToBuffer();
    } catch (e) {
      if (e instanceof RestError && e.statusCode === 404) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    await this.container.getBlockBlobClient(key).deleteIfExists({ deleteSnapshots: "include" });
  }
}

/** Connects with the server's managed identity. Only the account address and container name are configured. */
export async function azureBlobFromIdentity(accountUrl: string, containerName: string): Promise<AzureBlobStorage> {
  const [{ BlobServiceClient }, { DefaultAzureCredential }] = await Promise.all([import("@azure/storage-blob"), import("@azure/identity")]);
  const service = new BlobServiceClient(accountUrl, new DefaultAzureCredential());
  return new AzureBlobStorage(service.getContainerClient(containerName));
}
