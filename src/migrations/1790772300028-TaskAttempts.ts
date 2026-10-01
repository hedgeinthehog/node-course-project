import { MigrationInterface, QueryRunner } from 'typeorm';

export class TaskAttempts1790772300028 implements MigrationInterface {
  name = 'TaskAttempts1790772300028';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "tasks"
            ADD "attempts" integer NOT NULL DEFAULT '0'
        `);
    await queryRunner.query(`
            ALTER TABLE "tasks"
            ADD "last_error" text
        `);
    await queryRunner.query(`
            ALTER TABLE "tasks" DROP CONSTRAINT "chk_tasks_status"
        `);
    await queryRunner.query(`
            ALTER TABLE "tasks"
            ADD CONSTRAINT "chk_tasks_status" CHECK (status IN ('pending', 'done', 'failed'))
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            UPDATE "tasks" SET "status" = 'pending' WHERE "status" = 'failed'
        `);
    await queryRunner.query(`
            ALTER TABLE "tasks" DROP CONSTRAINT "chk_tasks_status"
        `);
    await queryRunner.query(`
            ALTER TABLE "tasks"
            ADD CONSTRAINT "chk_tasks_status" CHECK (status IN ('pending', 'done'))
        `);
    await queryRunner.query(`
            ALTER TABLE "tasks" DROP COLUMN "last_error"
        `);
    await queryRunner.query(`
            ALTER TABLE "tasks" DROP COLUMN "attempts"
        `);
  }
}
