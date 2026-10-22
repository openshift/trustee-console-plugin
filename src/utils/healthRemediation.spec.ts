import type { DeploymentKind, PodKind } from '../k8s/types';
import {
  deploymentRemediation,
  isCrashLooping,
  hasImagePullError,
  unhealthyConditions,
  type ConditionKind,
} from './healthRemediation';

const makeDeployment = (replicas: number, readyReplicas: number): DeploymentKind => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'test', namespace: 'ns' },
  spec: { replicas },
  status: { readyReplicas, availableReplicas: readyReplicas },
});

const makePod = (
  overrides: {
    phase?: string;
    waitingReason?: string;
    restartCount?: number;
  } = {},
): PodKind =>
  ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'pod-1', namespace: 'ns' },
    status: {
      phase: overrides.phase ?? 'Running',
      containerStatuses: [
        {
          ready: overrides.phase === 'Running' && !overrides.waitingReason,
          restartCount: overrides.restartCount ?? 0,
          state: overrides.waitingReason
            ? { waiting: { reason: overrides.waitingReason } }
            : { running: {} },
        },
      ],
    },
  }) as unknown as PodKind;

describe('deploymentRemediation', () => {
  it('returns undefined for a healthy deployment', () => {
    const dep = makeDeployment(1, 1);
    expect(deploymentRemediation(dep, [makePod()], false)).toBeUndefined();
  });

  it('returns danger hint when deployment is missing (operator)', () => {
    const result = deploymentRemediation(undefined, [], true);
    expect(result?.severity).toBe('danger');
    expect(result?.message).toContain('operator');
  });

  it('returns danger hint when deployment is missing (KBS)', () => {
    const result = deploymentRemediation(undefined, [], false);
    expect(result?.severity).toBe('danger');
    expect(result?.message).toContain('KBS');
  });

  it('returns warning when no pods exist', () => {
    const dep = makeDeployment(1, 0);
    const result = deploymentRemediation(dep, [], false);
    expect(result?.severity).toBe('warning');
    expect(result?.message).toContain('No pods');
  });

  it('returns danger when a pod is crash-looping', () => {
    const dep = makeDeployment(1, 0);
    const pod = makePod({ waitingReason: 'CrashLoopBackOff' });
    const result = deploymentRemediation(dep, [pod], false);
    expect(result?.severity).toBe('danger');
    expect(result?.message).toContain('crash-looping');
  });

  it('returns danger on image pull error', () => {
    const dep = makeDeployment(1, 0);
    const pod = makePod({ waitingReason: 'ImagePullBackOff' });
    const result = deploymentRemediation(dep, [pod], false);
    expect(result?.severity).toBe('danger');
    expect(result?.message).toContain('image pull');
  });

  it('returns warning when partially ready', () => {
    const dep = makeDeployment(3, 1);
    const result = deploymentRemediation(dep, [makePod()], false);
    expect(result?.severity).toBe('warning');
    expect(result?.message).toContain('replicas');
  });
});

describe('isCrashLooping', () => {
  it('detects CrashLoopBackOff', () => {
    expect(isCrashLooping(makePod({ waitingReason: 'CrashLoopBackOff' }))).toBe(true);
  });

  it('detects high restart count', () => {
    expect(isCrashLooping(makePod({ restartCount: 10 }))).toBe(true);
  });

  it('returns false for healthy pod', () => {
    expect(isCrashLooping(makePod())).toBe(false);
  });
});

describe('hasImagePullError', () => {
  it('detects ImagePullBackOff', () => {
    expect(hasImagePullError(makePod({ waitingReason: 'ImagePullBackOff' }))).toBe(true);
  });

  it('detects ErrImagePull', () => {
    expect(hasImagePullError(makePod({ waitingReason: 'ErrImagePull' }))).toBe(true);
  });

  it('returns false for healthy pod', () => {
    expect(hasImagePullError(makePod())).toBe(false);
  });
});

describe('unhealthyConditions', () => {
  it('filters conditions where status is not True', () => {
    const conditions: ConditionKind[] = [
      { type: 'Available', status: 'True' },
      { type: 'Ready', status: 'False', reason: 'NotReady', message: 'not ready' },
    ];
    const result = unhealthyConditions(conditions);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('Ready');
    expect(result[0].reason).toBe('NotReady');
  });

  it('returns empty for undefined conditions', () => {
    expect(unhealthyConditions(undefined)).toEqual([]);
  });

  it('returns empty for empty array', () => {
    expect(unhealthyConditions([])).toEqual([]);
  });
});
