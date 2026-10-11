import { DataSource, Repository } from 'typeorm';
import { User } from '../../src/entities/user.entity';
import { aUser, given } from './testkit/builders';
import { connect, pgError, resetDatabase } from './testkit/database';

describe('users repository', () => {
  let dataSource: DataSource;
  let users: Repository<User>;

  beforeAll(async () => {
    dataSource = await connect();
    users = dataSource.getRepository(User);
  });
  afterAll(() => dataSource.destroy());
  beforeEach(() => resetDatabase(dataSource));

  it('rejects a second user with the same email (unique constraint)', async () => {
    await given(dataSource).user({ email: 'same@example.com' });

    const duplicate = users.save(
      users.create(aUser({ email: 'same@example.com' })),
    );

    await expect(duplicate).rejects.toMatchObject(pgError('23505'));
    await expect(users.count()).resolves.toBe(1);
  });

  it('upsert by email updates the existing row instead of inserting (ON CONFLICT)', async () => {
    const original = aUser({ email: 'upsert@example.com', name: 'Before' });
    await users.upsert(original, ['email']);

    await users.upsert({ ...original, name: 'After' }, ['email']);

    const stored = await users.find();
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('After');
  });

  it('refuses to delete a seller who still has products (foreign key RESTRICT)', async () => {
    const { user, product } = given(dataSource);
    const seller = await user();
    await product({ sellerId: seller.id });

    await expect(users.delete(seller.id)).rejects.toMatchObject(
      pgError('23503'),
    );
    await expect(users.existsBy({ id: seller.id })).resolves.toBe(true);
  });

  it('rejects a negative balance (CHECK constraint)', async () => {
    const overdrawn = users.save(users.create(aUser({ balanceCents: '-1' })));

    await expect(overdrawn).rejects.toMatchObject(pgError('23514'));
  });
});
