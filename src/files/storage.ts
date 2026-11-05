import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { parseStorageEnv, StorageEnv } from '../config/env.schema';

export interface ObjectInfo {
  size: number;
  etag: string;
  contentType?: string;
  cacheControl?: string;
}

export interface UploadedPart {
  partNumber: number;
  size: number;
  etag: string;
}

export const ABORT_INCOMPLETE_AFTER_DAYS = 7;

const isMissing = (err: unknown) =>
  err instanceof S3ServiceException &&
  (err.$metadata.httpStatusCode === 404 ||
    ['NotFound', 'NoSuchKey', 'NoSuchBucket', 'NoSuchUpload'].includes(
      err.name,
    ));

export class Storage {
  readonly client: S3Client;
  readonly bucket: string;

  constructor(private readonly env: StorageEnv) {
    this.bucket = env.STORAGE_BUCKET;
    this.client = new S3Client({
      region: env.STORAGE_REGION,
      endpoint: env.STORAGE_ENDPOINT,
      forcePathStyle: Boolean(env.STORAGE_ENDPOINT),
      credentials: {
        accessKeyId: env.STORAGE_ACCESS_KEY,
        secretAccessKey: env.STORAGE_SECRET_KEY,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Storage {
    return new Storage(parseStorageEnv(env));
  }

  objectUrl(key: string): string {
    return this.env.STORAGE_ENDPOINT
      ? `${this.env.STORAGE_ENDPOINT}/${this.bucket}/${key}`
      : `https://${this.bucket}.s3.${this.env.STORAGE_REGION}.amazonaws.com/${key}`;
  }

  async ensureBucket(): Promise<boolean> {
    let created = false;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      if (!isMissing(err)) throw err;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      created = true;
    }
    await this.client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: this.bucket,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: 'abort-incomplete-multipart',
              Status: 'Enabled',
              Filter: { Prefix: '' },
              Expiration: { ExpiredObjectDeleteMarker: true },
              AbortIncompleteMultipartUpload: {
                DaysAfterInitiation: ABORT_INCOMPLETE_AFTER_DAYS,
              },
            },
          ],
        },
      }),
    );
    return created;
  }

  presignPut(key: string, contentType: string, ttlSec: number) {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: ttlSec },
    );
  }

  presignGet(key: string, ttlSec: number) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSec },
    );
  }

  presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    ttlSec: number,
  ) {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: ttlSec },
    );
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const object = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: object.ContentLength ?? 0,
        etag: object.ETag ?? '',
        contentType: object.ContentType,
        cacheControl: object.CacheControl,
      };
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async get(key: string): Promise<(ObjectInfo & { body: Buffer }) | null> {
    try {
      const object = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: object.ContentLength ?? 0,
        etag: object.ETag ?? '',
        contentType: object.ContentType,
        cacheControl: object.CacheControl,
        body: Buffer.from((await object.Body?.transformToByteArray()) ?? []),
      };
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async put(
    key: string,
    body: Buffer,
    contentType: string,
    cacheControl?: string,
  ): Promise<string> {
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl,
      }),
    );
    return result.ETag ?? '';
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key) keys.push(object.Key);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  async deleteAll(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
    }
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const upload = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!upload.UploadId) throw new Error('storage returned no UploadId');
    return upload.UploadId;
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const page = await this.client.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const part of page.Parts ?? []) {
        parts.push({
          partNumber: part.PartNumber ?? 0,
          size: part.Size ?? 0,
          etag: part.ETag ?? '',
        });
      }
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<string> {
    const result = await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
    return result.ETag ?? '';
  }

  async abortMultipart(key: string, uploadId: string): Promise<boolean> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
      return true;
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }

  async listMultipartUploads(
    prefix: string,
  ): Promise<{ key: string; uploadId: string }[]> {
    const uploads: { key: string; uploadId: string }[] = [];
    let keyMarker: string | undefined;
    let idMarker: string | undefined;
    do {
      const page = await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: this.bucket,
          Prefix: prefix,
          KeyMarker: keyMarker,
          UploadIdMarker: idMarker,
        }),
      );
      for (const upload of page.Uploads ?? []) {
        if (upload.Key && upload.UploadId) {
          uploads.push({ key: upload.Key, uploadId: upload.UploadId });
        }
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      idMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
    } while (keyMarker);
    return uploads;
  }
}
