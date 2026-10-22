// blob 儲存（ARCHITECTURE §14）：大型內容（完整的檔案內容、截圖）另外存放，Event 中只放 BlobRef。
// `blobs` 表記錄 metadata（sha256、大小、media type、所屬 Run、到期時間），內容由 BlobStore 保存。

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** 保存 blob 內容的地方。Phase 1 只有本機檔案系統的實作，之後可以換成物件儲存。 */
export interface BlobStore {
  put(key: string, data: Uint8Array): Promise<void>;
  /** 不存在時回傳 null。 */
  get(key: string): Promise<Uint8Array | null>;
  /** 不存在時不報錯。 */
  delete(key: string): Promise<void>;
}

/** blob 的預設保存天數。 */
export const BLOB_RETENTION_DAYS = 90;
export const BLOB_RETENTION_MS = BLOB_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** blob ID 對應的儲存位置：`<前兩個字元>/<id>`，避免單一目錄檔案過多。 */
export function blobStorageKey(blobId: string): string {
  return `${blobId.slice(0, 2)}/${blobId}`;
}

/** 存在本機目錄。key 一律由 blobStorageKey() 產生（只含 UUID 的字元），不接受外部輸入的路徑。 */
export class FileSystemBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    if (!/^[0-9a-f]{2}\/[0-9a-f-]{36}$/.test(key)) {
      throw new Error(`不合法的 blob key：${key}`);
    }
    return path.join(this.root, ...key.split("/"));
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    // 先寫暫存檔再改名，避免讀到寫到一半的內容。
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, data);
    await rm(file, { force: true });
    await rename(temp, file);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.resolve(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}

/** 測試用：存在記憶體。 */
export class MemoryBlobStore implements BlobStore {
  readonly data = new Map<string, Uint8Array>();

  async put(key: string, data: Uint8Array): Promise<void> {
    this.data.set(key, data);
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.data.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}
