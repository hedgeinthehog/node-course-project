import { MigrationInterface, QueryRunner } from 'typeorm';

export class Shipments1792153512100 implements MigrationInterface {
  name = 'Shipments1792153512100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "shipments" (
                "order_id" bigint NOT NULL,
                "event_id" uuid NOT NULL,
                "status" text NOT NULL DEFAULT 'pending',
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "chk_shipments_status" CHECK (status IN ('pending', 'shipped', 'delivered')),
                CONSTRAINT "PK_e86fac2a18a75dcb82bfbb23f43" PRIMARY KEY ("order_id")
            )
        `);
    await queryRunner.query(`
            ALTER TABLE "shipments"
            ADD CONSTRAINT "FK_e86fac2a18a75dcb82bfbb23f43" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "shipments" DROP CONSTRAINT "FK_e86fac2a18a75dcb82bfbb23f43"
        `);
    await queryRunner.query(`
            DROP TABLE "shipments"
        `);
  }
}
