import { setTimeout as sleep } from 'node:timers/promises';
import { finish, summary } from './cluster.mjs';
import { aws, record, stack } from './aws.mjs';

const TIMEOUT_S = 600;
const id = stack('demo', 'stack', 'output', 'dbIdentifier');
const instance = () =>
  aws('rds', 'describe-db-instances', '--db-instance-identifier', id)
    .DBInstances[0];

async function untilAvailable() {
  for (let i = 0; i < TIMEOUT_S / 5; i++) {
    const current = instance();
    if (current.DBInstanceStatus === 'available') return current;
    await sleep(5000);
  }
  throw new Error(`${id} did not become available in ${TIMEOUT_S} s`);
}

const before = await untilAvailable();
if (!before.MultiAZ) throw new Error(`${id} is not a Multi-AZ deployment`);

const started = Date.now();
aws(
  'rds',
  'reboot-db-instance',
  '--db-instance-identifier',
  id,
  '--force-failover',
);
let after = before;
while (Date.now() - started < TIMEOUT_S * 1000) {
  await sleep(3000);
  after = instance();
  if (
    after.DBInstanceStatus === 'available' &&
    after.AvailabilityZone !== before.AvailabilityZone
  ) {
    break;
  }
}
const seconds = Math.round((Date.now() - started) / 1000);

const events = aws(
  'rds',
  'describe-events',
  '--source-identifier',
  id,
  '--source-type',
  'db-instance',
  '--duration',
  '30',
).Events;
const event =
  events.findLast((item) => /failover/i.test(item.Message))?.Message ?? '';

const result = {
  'az-before': before.AvailabilityZone,
  'az-after': after.AvailabilityZone,
  'failover-seconds': seconds,
  event,
};
record(result);
summary(result);
finish(
  result['az-before'] !== result['az-after'] && event !== '',
  'the standby in the other availability zone took over',
);
