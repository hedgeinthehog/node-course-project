import { MigrationInterface, QueryRunner } from 'typeorm';

export class Auth1793688884983 implements MigrationInterface {
  name = 'Auth1793688884983';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "access_denylist" (
                "jti" uuid NOT NULL,
                "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                CONSTRAINT "PK_89cd12e7ebfce76332c07839e74" PRIMARY KEY ("jti")
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "refresh_tokens" (
                "id" uuid NOT NULL,
                "user_id" bigint NOT NULL,
                "family_id" uuid NOT NULL,
                "token_hash" text NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "used_at" TIMESTAMP WITH TIME ZONE,
                "revoked_at" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_7d8bee0204106019488c4c50ffa" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "idx_refresh_tokens_token_hash" ON "refresh_tokens" ("token_hash")
        `);
    await queryRunner.query(`
            CREATE INDEX "idx_refresh_tokens_family_id" ON "refresh_tokens" ("family_id")
        `);
    await queryRunner.query(`
            ALTER TABLE "users"
            ADD "role" text NOT NULL DEFAULT 'buyer'
        `);
    await queryRunner.query(`
            ALTER TABLE "users"
            ADD "password_hash" text
        `);
    await queryRunner.query(`
            ALTER TABLE "users"
            ADD CONSTRAINT "chk_users_role" CHECK (role IN ('buyer', 'seller', 'admin'))
        `);
    await queryRunner.query(`
            ALTER TABLE "refresh_tokens"
            ADD CONSTRAINT "FK_3ddc983c5f7bcf132fd8732c3f4" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "refresh_tokens" DROP CONSTRAINT "FK_3ddc983c5f7bcf132fd8732c3f4"
        `);
    await queryRunner.query(`
            ALTER TABLE "users" DROP CONSTRAINT "chk_users_role"
        `);
    await queryRunner.query(`
            ALTER TABLE "users" DROP COLUMN "password_hash"
        `);
    await queryRunner.query(`
            ALTER TABLE "users" DROP COLUMN "role"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."idx_refresh_tokens_family_id"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."idx_refresh_tokens_token_hash"
        `);
    await queryRunner.query(`
            DROP TABLE "refresh_tokens"
        `);
    await queryRunner.query(`
            DROP TABLE "access_denylist"
        `);
  }
}
