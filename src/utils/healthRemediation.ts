import type { ContainerStatusKind, DeploymentKind, PodKind } from '../k8s/types';

export type HealthSeverity = 'success' | 'warning' | 'danger' | 'info';

export interface RemediationHint {
  severity: HealthSeverity;
  message: string;
}

/**
 * Derive an actionable remediation hint from a Deployment's current state and
 * its associated pods. Returns `undefined` when the Deployment is healthy.
 */
export const deploymentRemediation = (
  deployment: DeploymentKind | undefined,
  pods: PodKind[],
  isOperator: boolean,
): RemediationHint | undefined => {
  if (!deployment) {
    return isOperator
      ? {
          severity: 'danger',
          message:
            'The Trustee operator Deployment was not found. Verify the operator is installed from OperatorHub.',
        }
      : {
          severity: 'danger',
          message:
            'The KBS Deployment was not found. The operator may not have reconciled the TrusteeConfig yet.',
        };
  }

  const desired = deployment.spec?.replicas ?? 0;
  const ready = deployment.status?.readyReplicas ?? 0;

  if (desired > 0 && ready >= desired) return undefined;

  const crashLooping = pods.some((p) => isCrashLooping(p));
  const imagePull = pods.some((p) => hasImagePullError(p));

  if (ready === 0 && pods.length === 0) {
    return {
      severity: 'warning',
      message:
        'No pods have been created yet. The operator may still be reconciling — if this persists, check the operator pod logs.',
    };
  }

  if (crashLooping) {
    return {
      severity: 'danger',
      message:
        'A pod is crash-looping. Check pod logs for a missing TLS secret, malformed KBS config, or OOM. Click the pod link above to view logs.',
    };
  }

  if (imagePull) {
    return {
      severity: 'danger',
      message:
        'A pod has an image pull error. Verify the container image exists and pull secrets are configured.',
    };
  }

  if (ready > 0 && ready < desired) {
    return {
      severity: 'warning',
      message:
        'Some replicas are not ready. Check pod events for scheduling constraints, resource limits, or node affinity issues.',
    };
  }

  return {
    severity: 'warning',
    message: 'The Deployment is not fully available. Check pod status and events for details.',
  };
};

export const isCrashLooping = (pod: PodKind): boolean => {
  const statuses: ContainerStatusKind[] = pod.status?.containerStatuses ?? [];
  return statuses.some(
    (c) => c.state?.waiting?.reason === 'CrashLoopBackOff' || (c.restartCount ?? 0) > 5,
  );
};

export const hasImagePullError = (pod: PodKind): boolean => {
  const statuses: ContainerStatusKind[] = pod.status?.containerStatuses ?? [];
  return statuses.some(
    (c) =>
      c.state?.waiting?.reason === 'ImagePullBackOff' ||
      c.state?.waiting?.reason === 'ErrImagePull',
  );
};

export interface ConditionKind {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

/**
 * Filter conditions to those that indicate a problem (status !== 'True').
 * Returns an empty array when all conditions are healthy.
 */
export const unhealthyConditions = (conditions: ConditionKind[] | undefined): ConditionKind[] => {
  if (!conditions?.length) return [];
  return conditions.filter((c) => c.status !== 'True');
};

/** Threshold above which we flag restarts as a warning on the pod row. */
export const HIGH_RESTART_THRESHOLD = 3;
