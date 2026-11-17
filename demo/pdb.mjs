import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  APP,
  CONTEXT,
  finish,
  kubectl,
  NAMESPACE,
  summary,
  waitForRollout,
} from './cluster.mjs';

const budget = () => JSON.parse(kubectl('get', 'pdb', APP, '-o', 'json'));

async function startProxy() {
  const proxy = spawn('kubectl', ['--context', CONTEXT, 'proxy', '--port=0'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const address = await new Promise((resolve, reject) => {
    let out = '';
    proxy.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /Starting to serve on (\S+)/.exec(out);
      if (match) resolve(match[1]);
    });
    proxy.once('exit', (code) =>
      reject(new Error(`kubectl proxy exited with ${code}`)),
    );
  });
  return { proxy, base: `http://${address}` };
}

async function evict(base, pod) {
  const response = await fetch(
    `${base}/api/v1/namespaces/${NAMESPACE}/pods/${pod}/eviction`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiVersion: 'policy/v1',
        kind: 'Eviction',
        metadata: { name: pod, namespace: NAMESPACE },
      }),
    },
  );
  await response.text();
  return response.status;
}

waitForRollout();
let pdb = budget();
for (let i = 0; i < 60 && pdb.status.disruptionsAllowed < 1; i++) {
  await sleep(1000);
  pdb = budget();
}
const pods = JSON.parse(
  kubectl('get', 'pods', '-l', `app=${APP}`, '-o', 'json'),
)
  .items.filter(
    (pod) =>
      !pod.metadata.deletionTimestamp &&
      pod.status.conditions?.some(
        (condition) =>
          condition.type === 'Ready' && condition.status === 'True',
      ),
  )
  .map((pod) => pod.metadata.name);
if (pods.length < 2)
  throw new Error(`need two ready pods, found ${pods.length}`);

const { proxy, base } = await startProxy();
let first;
let second;
try {
  first = await evict(base, pods[0]);
  second = await evict(base, pods[1]);
} finally {
  proxy.kill('SIGTERM');
}
console.log(`evicted ${pods[0]}, then tried ${pods[1]}`);
if (first === 201) {
  kubectl('wait', '--for=delete', `pod/${pods[0]}`, '--timeout=120s');
}
waitForRollout();
const whole = () => {
  const { spec, status } = JSON.parse(
    kubectl('get', 'deployment', APP, '-o', 'json'),
  );
  return status.readyReplicas === spec.replicas;
};
for (let i = 0; i < 120 && !whole(); i++) await sleep(1000);
if (!whole()) throw new Error('the deployment did not return to full strength');

summary({
  healthy: pdb.status.currentHealthy,
  minAvailable: pdb.spec.minAvailable,
  'disruptions-allowed-before': pdb.status.disruptionsAllowed,
  'evict-1': first,
  'evict-2': second,
});
finish(
  first === 201 && second === 429,
  'the budget let one pod go and refused the second eviction; the deployment is back to full strength',
);
