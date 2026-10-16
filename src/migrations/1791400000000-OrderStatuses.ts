import { MigrationInterface, QueryRunner } from 'typeorm';

export class OrderStatuses1791400000000 implements MigrationInterface {
  name = 'OrderStatuses1791400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "orders" DROP CONSTRAINT "chk_orders_status"
        `);
    await queryRunner.query(`
            ALTER TABLE "orders"
            ADD CONSTRAINT "chk_orders_status" CHECK (status IN ('pending', 'paid', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'))
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            UPDATE "orders" SET "status" = 'paid'
            WHERE "status" IN ('processing', 'shipped', 'out_for_delivery', 'delivered')
        `);
    await queryRunner.query(`
            ALTER TABLE "orders" DROP CONSTRAINT "chk_orders_status"
        `);
    await queryRunner.query(`
            ALTER TABLE "orders"
            ADD CONSTRAINT "chk_orders_status" CHECK (status IN ('pending', 'paid', 'cancelled'))
        `);
  }
}
