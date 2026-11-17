import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Env } from '../config/env.schema';
import { StoredFile } from '../entities/stored-file.entity';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { Storage } from './storage';

@Module({
  imports: [TypeOrmModule.forFeature([StoredFile])],
  controllers: [FilesController],
  providers: [
    {
      provide: Storage,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new Storage({
          STORAGE_ENDPOINT: config.get('STORAGE_ENDPOINT', { infer: true }),
          STORAGE_REGION: config.get('STORAGE_REGION', { infer: true }),
          STORAGE_ACCESS_KEY: config.get('STORAGE_ACCESS_KEY', { infer: true }),
          STORAGE_SECRET_KEY: config.get('STORAGE_SECRET_KEY', { infer: true }),
          STORAGE_BUCKET: config.get('STORAGE_BUCKET', { infer: true }),
        }),
    },
    FilesService,
  ],
  exports: [Storage],
})
export class FilesModule {}
