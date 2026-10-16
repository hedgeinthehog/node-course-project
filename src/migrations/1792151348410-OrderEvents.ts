import { MigrationInterface, QueryRunner } from 'typeorm';

export class OrderEvents1792151348410 implements MigrationInterface {
  name = 'OrderEvents1792151348410';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "order_events" (
                "order_id" bigint NOT NULL,
                "seq" integer NOT NULL,
                "status" text NOT NULL,
                "previous" text NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "chk_order_events_previous" CHECK (
                    previous IN (
                        'pending',
                        'paid',
                        'processing',
                        'shipped',
                        'out_for_delivery',
                        'delivered',
                        'cancelled'
                    )
                ),
                CONSTRAINT "chk_order_events_status" CHECK (
                    status IN (
                        'pending',
                        'paid',
                        'processing',
                        'shipped',
                        'out_for_delivery',
                        'delivered',
                        'cancelled'
                    )
                ),
                CONSTRAINT "chk_order_events_seq" CHECK (seq > 0),
                CONSTRAINT "PK_d7262877d0b0fe08e91f341deff" PRIMARY KEY ("order_id", "seq")
            )
        `);
    await queryRunner.query(`
            ALTER TABLE "order_events"
            ADD CONSTRAINT "FK_b33cbf9a59cbee112d94bcb59de" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "order_events" DROP CONSTRAINT "FK_b33cbf9a59cbee112d94bcb59de"
        `);
    await queryRunner.query(`
            DROP TABLE "order_events"
        `);
  }
}
