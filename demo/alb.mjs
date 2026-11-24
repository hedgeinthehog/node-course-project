import { setTimeout as sleep } from 'node:timers/promises';
import { finish, summary } from './cluster.mjs';
import { aws, record, stack } from './aws.mjs';

const dns = stack('demo', 'stack', 'output', 'albDnsName');
const targetGroup = stack('demo', 'stack', 'output', 'targetGroupArn');

const targetState = () =>
  aws('elbv2', 'describe-target-health', '--target-group-arn', targetGroup)
    .TargetHealthDescriptions[0]?.TargetHealth.State ?? 'none';

let state = targetState();
let code = 0;
for (let i = 0; i < 60 && !(state === 'healthy' && code === 200); i++) {
  await sleep(5000);
  state = targetState();
  code = await fetch(`http://${dns}/healthz`).then(
    (response) => response.status,
    () => 0,
  );
}

const result = { 'alb-dns': dns, 'http-code': code, 'target-state': state };
record(result);
summary(result);
finish(
  code === 200 && state === 'healthy',
  'the load balancer answers 200 and its target is in rotation',
);
