import { MigrationInterface, QueryRunner } from 'typeorm';

export class OutboxRetry1793685085141 implements MigrationInterface {
  name = 'OutboxRetry1793685085141';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "outbox"
            ADD "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
        `);
    await queryRunner.query(`
            ALTER TABLE "outbox"
            ADD "failed_at" TIMESTAMP WITH TIME ZONE
        `);
    await queryRunner.query(`
            ALTER TABLE "outbox"
            ADD "last_error" text
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "outbox" DROP COLUMN "last_error"
        `);
    await queryRunner.query(`
            ALTER TABLE "outbox" DROP COLUMN "failed_at"
        `);
    await queryRunner.query(`
            ALTER TABLE "outbox" DROP COLUMN "next_attempt_at"
        `);
  }
}
