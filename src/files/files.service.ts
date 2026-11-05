import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { Principal } from '../auth/auth.service';
import { IdempotencyStore, IdempotentResult } from '../common/idempotency';
import { StoredFile } from '../entities/stored-file.entity';
import { Storage, UploadedPart } from './storage';
import {
  extensionFor,
  GET_URL_TTL_S,
  isMultipart,
  MAX_FILE_SIZE,
  partCountFor,
  partSizeFor,
  PUT_URL_TTL_S,
} from './upload-policy';

export interface UploadIntentDto {
  filename: string;
  content_type: string;
  size: number;
}

export interface PartUrl {
  part_number: number;
  url: string;
}

export interface UploadPlan {
  file_id: string;
  key: string;
  expires_in: number;
  upload:
    | { type: 'single'; url: string }
    | {
        type: 'multipart';
        upload_id: string;
        part_size: number;
        size: number;
        parts: PartUrl[];
      };
}

export interface UploadPartsDto {
  file_id: string;
  key: string;
  upload_id: string;
  part_size: number;
  size: number;
  expires_in: number;
  uploaded: { part_number: number; size: number; etag: string }[];
  parts: PartUrl[];
}

export interface StoredFileDto {
  id: string;
  key: string;
  owner_id: number;
  content_type: string;
  size: number;
  status: string;
  etag: string | null;
  created_at: string;
  completed_at: string | null;
}

const toDto = (file: StoredFile): StoredFileDto => ({
  id: file.id,
  key: file.key,
  owner_id: Number(file.ownerId),
  content_type: file.contentType,
  size: Number(file.size),
  status: file.status,
  etag: file.etag,
  created_at: file.createdAt.toISOString(),
  completed_at: file.completedAt?.toISOString() ?? null,
});

@Injectable()
export class FilesService {
  private readonly idempotency: IdempotencyStore;

  constructor(
    @InjectRepository(StoredFile)
    private readonly files: Repository<StoredFile>,
    private readonly dataSource: DataSource,
    private readonly storage: Storage,
  ) {
    this.idempotency = new IdempotencyStore(dataSource);
  }

  intent(
    key: string,
    dto: UploadIntentDto,
    actor: Principal,
  ): Promise<IdempotentResult<UploadPlan>> {
    const extension = extensionFor(dto.content_type);
    if (!extension) {
      throw new BadRequestException(
        `unsupported content type ${dto.content_type}`,
      );
    }
    if (
      !Number.isInteger(dto.size) ||
      dto.size < 1 ||
      dto.size > MAX_FILE_SIZE
    ) {
      throw new BadRequestException(`size must be 1..${MAX_FILE_SIZE} bytes`);
    }
    return this.idempotency.run(
      key,
      { ...dto, owner: actor.id },
      async (manager) => {
        const objectKey = `uploads/${actor.id}/${randomUUID()}.${extension}`;
        const file = manager.create(StoredFile, {
          id: randomUUID(),
          key: objectKey,
          ownerId: actor.id,
          contentType: dto.content_type,
          size: String(dto.size),
          status: 'pending',
          uploadId: null,
          etag: null,
          completedAt: null,
        });
        let upload: UploadPlan['upload'];
        if (isMultipart(dto.size)) {
          file.uploadId = await this.storage.createMultipart(
            objectKey,
            dto.content_type,
          );
          const partSize = partSizeFor(dto.size);
          upload = {
            type: 'multipart',
            upload_id: file.uploadId,
            part_size: partSize,
            size: dto.size,
            parts: await this.partUrls(
              objectKey,
              file.uploadId,
              partSize,
              dto.size,
              [],
            ),
          };
        } else {
          upload = {
            type: 'single',
            url: await this.storage.presignPut(
              objectKey,
              dto.content_type,
              PUT_URL_TTL_S,
            ),
          };
        }
        await manager.save(file);
        return {
          file_id: file.id,
          key: objectKey,
          expires_in: PUT_URL_TTL_S,
          upload,
        };
      },
    );
  }

  async parts(fileId: string, actor: Principal): Promise<UploadPartsDto> {
    const file = await this.owned(fileId, actor);
    if (file.status !== 'pending' || !file.uploadId) {
      throw new ConflictException('not a pending multipart upload');
    }
    const size = Number(file.size);
    const partSize = partSizeFor(size);
    const uploaded = await this.storage.listParts(file.key, file.uploadId);
    return {
      file_id: file.id,
      key: file.key,
      upload_id: file.uploadId,
      part_size: partSize,
      size,
      expires_in: PUT_URL_TTL_S,
      uploaded: uploaded.map((part) => ({
        part_number: part.partNumber,
        size: part.size,
        etag: part.etag,
      })),
      parts: await this.partUrls(
        file.key,
        file.uploadId,
        partSize,
        size,
        uploaded,
      ),
    };
  }

  async commit(fileId: string, actor: Principal): Promise<StoredFileDto> {
    const file = await this.owned(fileId, actor);
    if (file.status === 'completed') return toDto(file);
    const size = Number(file.size);
    if (file.uploadId) {
      const parts = await this.storage.listParts(file.key, file.uploadId);
      const expected = partCountFor(size, partSizeFor(size));
      if (parts.length !== expected) {
        throw new ConflictException(
          `${parts.length} of ${expected} parts are uploaded, nothing to complete yet`,
        );
      }
      await this.storage.completeMultipart(file.key, file.uploadId, parts);
    }
    const object = await this.storage.head(file.key);
    if (!object) {
      throw new ConflictException('no object was uploaded for this intent');
    }
    if (object.size !== size) {
      throw new ConflictException(
        `uploaded object has ${object.size} bytes, the intent declared ${size}`,
      );
    }
    file.status = 'completed';
    file.etag = object.etag;
    file.completedAt = new Date();
    await this.files.save(file);
    return toDto(file);
  }

  async downloadUrl(fileId: string, actor: Principal): Promise<string> {
    const file = await this.owned(fileId, actor);
    if (file.status !== 'completed') {
      throw new ConflictException('the upload is not committed yet');
    }
    return this.storage.presignGet(file.key, GET_URL_TTL_S);
  }

  private async partUrls(
    key: string,
    uploadId: string,
    partSize: number,
    size: number,
    uploaded: UploadedPart[],
  ): Promise<PartUrl[]> {
    const present = new Set(uploaded.map((part) => part.partNumber));
    const urls: PartUrl[] = [];
    for (let n = 1; n <= partCountFor(size, partSize); n++) {
      if (present.has(n)) continue;
      urls.push({
        part_number: n,
        url: await this.storage.presignPart(key, uploadId, n, PUT_URL_TTL_S),
      });
    }
    return urls;
  }

  private async owned(fileId: string, actor: Principal): Promise<StoredFile> {
    const file = await this.files.findOneBy({ id: fileId });
    if (!file) throw new NotFoundException(`file ${fileId} not found`);
    if (actor.role !== 'admin' && file.ownerId !== actor.id) {
      throw new ForbiddenException('forbidden');
    }
    return file;
  }
}
