import { setTimeout as sleep } from 'node:timers/promises';
import { finish, summary } from './cluster.mjs';
import { aws, demoUrn, record, stack } from './aws.mjs';

const targets = [
  ['aws:ec2/eip:Eip', 'nat'],
  ['aws:ec2/natGateway:NatGateway', 'nat'],
].flatMap(([type, name]) => ['--target', demoUrn(type, name)]);

const gateways = (state) =>
  aws(
    'ec2',
    'describe-nat-gateways',
    '--filter',
    `Name=state,Values=${state}`,
    'Name=tag:Name,Values=hw31-nat',
  ).NatGateways;

let created;
let removed;
stack('demo', 'config', 'set', 'withNat', 'true');
try {
  stack('demo', 'up', ...targets);
  const [gateway] = gateways('available');
  if (!gateway) throw new Error('the NAT gateway did not become available');
  created = new Date(gateway.CreateTime).getTime();
  await sleep(5000);
} finally {
  stack('demo', 'destroy', ...targets);
  removed = Date.now();
  stack('demo', 'config', 'set', 'withNat', 'false');
}

const minutes = Math.max(1, Math.ceil((removed - created) / 60_000));
const result = {
  'nat-minutes': minutes,
  'nat-billed-hours': Math.ceil(minutes / 60),
  'nat-left': gateways('available').length,
  'eip-left': aws('ec2', 'describe-addresses').Addresses.length,
};
record(result);
summary(result);
finish(
  result['nat-minutes'] < 60 &&
    result['nat-billed-hours'] === 1 &&
    result['nat-left'] === 0 &&
    result['eip-left'] === 0,
  'the gateway lived for minutes and is billed as a full hour; nothing of it is left',
);
