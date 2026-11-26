export const HOURS_PER_MONTH = 730;

export const RATES = {
  vcpuHourUsd: 0.04048,
  memoryGbHourUsd: 0.004445,
};

interface Container {
  resources?: { requests?: { cpu?: string | number; memory?: string } };
}

interface PlanStep {
  op: string;
  urn: string;
  newState?: {
    type: string;
    inputs?: {
      spec?: {
        replicas?: number;
        template?: { spec?: { containers?: Container[] } };
      };
    };
  };
}

export interface Plan {
  steps?: PlanStep[];
}

export interface CostLine {
  resource: string;
  replicas: number;
  vcpu: number;
  memoryGb: number;
  usdPerMonth: number;
}

const MEMORY_UNITS: Record<string, number> = {
  Ki: 1 / 1024 ** 2,
  Mi: 1 / 1024,
  Gi: 1,
  K: 1e3 / 1024 ** 3,
  M: 1e6 / 1024 ** 3,
  G: 1e9 / 1024 ** 3,
};

export function vcpu(value: string | number | undefined): number {
  if (value === undefined) return 0;
  const text = String(value);
  return text.endsWith('m') ? Number(text.slice(0, -1)) / 1000 : Number(text);
}

export function memoryGb(value: string | undefined): number {
  if (!value) return 0;
  const [, amount, unit] = /^([\d.]+)([A-Za-z]*)$/.exec(value) ?? [];
  if (!amount) return 0;
  return Number(amount) * (unit ? (MEMORY_UNITS[unit] ?? 0) : 1 / 1024 ** 3);
}

export function monthlyCost(plan: Plan): CostLine[] {
  return (plan.steps ?? [])
    .filter(
      (step) =>
        step.op !== 'delete' &&
        step.newState?.type === 'kubernetes:apps/v1:Deployment',
    )
    .map((step) => {
      const spec = step.newState?.inputs?.spec;
      const replicas = spec?.replicas ?? 1;
      const containers = spec?.template?.spec?.containers ?? [];
      const cpu =
        replicas *
        containers.reduce(
          (sum, item) => sum + vcpu(item.resources?.requests?.cpu),
          0,
        );
      const memory =
        replicas *
        containers.reduce(
          (sum, item) => sum + memoryGb(item.resources?.requests?.memory),
          0,
        );
      return {
        resource: step.urn.split('::').at(-1) ?? step.urn,
        replicas,
        vcpu: cpu,
        memoryGb: memory,
        usdPerMonth:
          (cpu * RATES.vcpuHourUsd + memory * RATES.memoryGbHourUsd) *
          HOURS_PER_MONTH,
      };
    });
}
