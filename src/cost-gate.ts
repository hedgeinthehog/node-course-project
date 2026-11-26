import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { monthlyCost, Plan } from './mapping';

const planFile = process.env.PLAN_JSON;
if (!planFile) {
  console.error(
    'gate:cost: PLAN_JSON must point at the output of pulumi preview --json',
  );
  process.exit(2);
}
const policy: {
  budgetUsd: number;
  baselineUsd: number;
  maxDeltaUsd: number;
  maxDeltaPercent: number;
} = JSON.parse(
  readFileSync(join(__dirname, '..', 'infra', 'cost-policy.json'), 'utf8'),
);
const budget = Number(process.env.COST_BUDGET_USD || policy.budgetUsd);
if (!Number.isFinite(budget)) {
  console.error(
    `gate:cost: COST_BUDGET_USD must be a number, got "${process.env.COST_BUDGET_USD}"`,
  );
  process.exit(2);
}

const plan: Plan = JSON.parse(readFileSync(planFile, 'utf8'));
const lines = monthlyCost(plan);
const total = lines.reduce((sum, line) => sum + line.usdPerMonth, 0);
const delta = total - policy.baselineUsd;
const deltaPercent =
  policy.baselineUsd > 0 ? (delta / policy.baselineUsd) * 100 : 0;
const overBudget = total > budget;
const jumped =
  delta > policy.maxDeltaUsd || deltaPercent > policy.maxDeltaPercent;

for (const line of lines.filter((item) => item.usdPerMonth > 0)) {
  console.log(
    `line ${line.resource}: ${line.replicas} x (${(line.vcpu / line.replicas).toFixed(2)} vCPU, ${(line.memoryGb / line.replicas).toFixed(4)} GiB) = ${line.usdPerMonth.toFixed(2)} USD/month`,
  );
}
console.log(`budget-usd=${budget}`);
console.log(`plan-usd=${total.toFixed(2)}`);
console.log(`baseline-usd=${policy.baselineUsd}`);
console.log(`delta-usd=${delta.toFixed(2)}`);
console.log(`delta-percent=${deltaPercent.toFixed(1)}`);
console.log(`gate=${overBudget || jumped ? 'fail' : 'pass'}`);
process.exit(overBudget || jumped ? 1 : 0);
