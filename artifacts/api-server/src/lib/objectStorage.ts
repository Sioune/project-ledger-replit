import { createHash, randomUUID } from 'crypto';
import { Readable } from 'stream';
import { File, Storage } from '@google-cloud/storage';

import {
  canAccessObject,
  getObjectAclPolicy,
  ObjectAclPolicy,
  ObjectPermission,
  setObjectAclPolicy,
} from './objectAcl';

const PRIVATE_IMAGE_PATH = /^\/objects\/account-imports\/[0-9a-f-]{36}\/img_[a-f0-9]{64}$/;
const PRIVATE_ACCOUNT_FILE_PATH = /^\/objects\/account-files\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;
const PRIVATE_ACCOUNT_FILE_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/pdf',
  'text/html', 'text/markdown', 'text/x-markdown', 'text/plain', 'image/jpeg', 'image/png', 'image/webp',
]);
// Uses Google Application Default Credentials; prefer workload identity over key files.
export const objectStorageClient = new Storage();

export class ObjectNotFoundError extends Error {
  constructor() {
    super('Object not found');
    this.name = 'ObjectNotFoundError';
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectStorageService {
  constructor() {}

  async writePrivateObject(
    objectPath: string,
    bytes: Buffer,
    mimeType: string,
    ownerId: string,
  ): Promise<void> {
    if (
      !PRIVATE_IMAGE_PATH.test(objectPath) ||
      !ownerId ||
      !["image/png", "image/jpeg", "image/webp"].includes(mimeType)
    ) {
      throw new Error("Invalid private import object.");
    }
    const privateDir = this.getPrivateObjectDir().replace(/\/$/, "");
    const { bucketName, objectName } = parseObjectPath(`${privateDir}${objectPath.slice("/objects".length)}`);
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    await file.save(bytes, {
      resumable: false,
      metadata: {
        contentType: mimeType,
        cacheControl: "private, no-store",
      },
    });
    try {
      await setObjectAclPolicy(file, { owner: ownerId, visibility: "private" });
    } catch (error) {
      await file.delete({ ignoreNotFound: true }).catch(() => undefined);
      throw error;
    }
  }

  async deletePrivateObject(objectPath: string): Promise<void> {
    if (!PRIVATE_IMAGE_PATH.test(objectPath) && !PRIVATE_ACCOUNT_FILE_PATH.test(objectPath)) {
      throw new Error("Invalid private import object path.");
    }
    const privateDir = this.getPrivateObjectDir().replace(/\/$/, "");
    const { bucketName, objectName } = parseObjectPath(`${privateDir}${objectPath.slice("/objects".length)}`);
    await objectStorageClient.bucket(bucketName).file(objectName).delete({ ignoreNotFound: true });
  }

  async verifyPrivateObject(
    objectPath: string,
    expectedBytes: Buffer,
    expectedMime: string,
    ownerId: string,
  ): Promise<boolean> {
    if (!PRIVATE_IMAGE_PATH.test(objectPath)) return false;
    const file = await this.getObjectEntityFile(objectPath);
    const [metadata] = await file.getMetadata();
    const policy = await getObjectAclPolicy(file);
    const [bytes] = await file.download();
    return (
      metadata.contentType === expectedMime &&
      Number(metadata.size) === expectedBytes.length &&
      createHash("sha256").update(bytes).digest("hex") === createHash("sha256").update(expectedBytes).digest("hex") &&
      !!policy &&
      policy.visibility === "private" &&
      policy.owner === ownerId
    );
  }

  async writePrivateAccountFile(
    objectPath: string,
    bytes: Buffer,
    mimeType: string,
    ownerId: string,
  ): Promise<void> {
    if (!PRIVATE_ACCOUNT_FILE_PATH.test(objectPath) || !ownerId || !PRIVATE_ACCOUNT_FILE_MIMES.has(mimeType)) {
      throw new Error('Invalid private account file.');
    }
    const privateDir = this.getPrivateObjectDir().replace(/\/$/, '');
    const { bucketName, objectName } = parseObjectPath(`${privateDir}${objectPath.slice('/objects'.length)}`);
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    await file.save(bytes, {
      resumable: false,
      metadata: { contentType: mimeType, cacheControl: 'private, no-store' },
    });
    try {
      await setObjectAclPolicy(file, { owner: ownerId, visibility: 'private' });
    } catch (error) {
      await file.delete({ ignoreNotFound: true }).catch(() => undefined);
      throw error;
    }
  }

  async verifyPrivateAccountFile(
    objectPath: string,
    expectedBytes: Buffer,
    expectedMime: string,
    ownerId: string,
  ): Promise<boolean> {
    if (!PRIVATE_ACCOUNT_FILE_PATH.test(objectPath) || !PRIVATE_ACCOUNT_FILE_MIMES.has(expectedMime)) return false;
    const file = await this.getObjectEntityFile(objectPath);
    const [metadata] = await file.getMetadata();
    const policy = await getObjectAclPolicy(file);
    const [bytes] = await file.download();
    return metadata.contentType === expectedMime &&
      Number(metadata.size) === expectedBytes.length &&
      createHash('sha256').update(bytes).digest('hex') === createHash('sha256').update(expectedBytes).digest('hex') &&
      !!policy && policy.visibility === 'private' && policy.owner === ownerId;
  }

  async getOwnedPrivateAccountFile(objectPath: string, ownerId: string): Promise<{ file: File; metadata: Record<string, unknown> }> {
    if (!PRIVATE_ACCOUNT_FILE_PATH.test(objectPath) || !ownerId) throw new ObjectNotFoundError();
    const file = await this.getObjectEntityFile(objectPath);
    const [metadata] = await file.getMetadata();
    const policy = await getObjectAclPolicy(file);
    if (!policy || policy.visibility !== 'private' || policy.owner !== ownerId) throw new ObjectNotFoundError();
    return { file, metadata: metadata as Record<string, unknown> };
  }

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || '';
    const paths = Array.from(
      new Set(
        pathsStr
          .split(',')
          .map((path) => path.trim())
          .filter((path) => path.length > 0),
      ),
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          'tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths).',
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || '';
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          'tool and set PRIVATE_OBJECT_DIR env var.',
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  async downloadObject(
    file: File,
    cacheTtlSec: number = 3600,
  ): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === 'public';

    const nodeStream = file.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers: Record<string, string> = {
      'Content-Type':
        (metadata.contentType as string) || 'application/octet-stream',
      'Cache-Control': `${isPublic ? 'public' : 'private'}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers['Content-Length'] = String(metadata.size);
    }

    return new Response(webStream, { headers });
  }

  async getObjectEntityUploadURL(): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          'tool and set PRIVATE_OBJECT_DIR env var.',
      );
    }

    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${objectId}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    return signObjectURL({
      bucketName,
      objectName,
      method: 'PUT',
      ttlSec: 900,
    });
  }

  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (!objectPath.startsWith('/objects/')) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split('/');
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join('/');
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith('/')) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (!rawPath.startsWith('https://storage.googleapis.com/')) {
      return rawPath;
    }

    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith('/')) {
      objectEntityDir = `${objectEntityDir}/`;
    }

    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy,
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith('/')) {
      return normalizedPath;
    }

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: File;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  const pathParts = path.split('/');
  if (pathParts.length < 3) {
    throw new Error('Invalid path: must contain at least a bucket name');
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join('/');

  return {
    bucketName,
    objectName,
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
  ttlSec: number;
}): Promise<string> {
  const action = method === 'PUT' ? 'write' : method === 'DELETE' ? 'delete' : 'read';
  const [url] = await objectStorageClient.bucket(bucketName).file(objectName).getSignedUrl({
    version: 'v4', action, expires: Date.now() + ttlSec * 1000,
  });
  if (!url.startsWith('https://')) throw new Error('Object storage returned an invalid signed URL.');
  return url;
}
