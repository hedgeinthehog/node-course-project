import { MigrationInterface, QueryRunner } from 'typeorm';

export class Files1793900000000 implements MigrationInterface {
  name = 'Files1793900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "files" (
                "id" uuid NOT NULL,
                "key" text NOT NULL,
                "owner_id" bigint NOT NULL,
                "content_type" text NOT NULL,
                "size" bigint NOT NULL,
                "status" text NOT NULL,
                "upload_id" text,
                "etag" text,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "completed_at" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "pk_files" PRIMARY KEY ("id"),
                CONSTRAINT "chk_files_status" CHECK (status IN ('pending', 'completed')),
                CONSTRAINT "fk_files_owner" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE
            )
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "uq_files_key" ON "files" ("key")
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_files_pending_created_at" ON "files" ("created_at") WHERE status = 'pending'
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP TABLE "files"
        `);
  }
}
