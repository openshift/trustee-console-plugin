// Every string a component passes to t() through a variable (t(hint.message),
// t(warningText)) must be enumerated in i18nStaticKeys so the i18n extractor
// lands it in the translation catalog — otherwise it renders English in every
// locale. This spec drives each producing util through all of its message
// branches and asserts the returned strings are enumerated, so the list cannot
// drift from the utils it mirrors.
import { readFileSync } from 'fs';
import { join } from 'path';
import { i18nStaticKeys } from './i18nKeys';
import { deploymentRemediation } from './healthRemediation';
import { regoWarning, resourcePolicyWarning, PERMISSIVE_RESOURCE_POLICY } from './rego';
import type { DeploymentKind, PodKind } from '../k8s/types';

const catalog: Record<string, string> = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', 'locales', 'en', 'plugin__trustee-openshift-console-plugin.json'),
    'utf8',
  ),
);

const identity = (key: string): string => key;
const keys = i18nStaticKeys(identity);

const makeDeployment = (replicas: number, readyReplicas: number): DeploymentKind => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'test', namespace: 'ns' },
  spec: { replicas },
  status: { readyReplicas, availableReplicas: readyReplicas },
});

const makePod = (waitingReason?: string): PodKind =>
  ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'pod-1', namespace: 'ns' },
    status: {
      phase: 'Running',
      containerStatuses: [
        {
          ready: !waitingReason,
          restartCount: 0,
          state: waitingReason ? { waiting: { reason: waitingReason } } : { running: {} },
        },
      ],
    },
  }) as unknown as PodKind;

describe('i18nStaticKeys', () => {
  it('enumerates every deploymentRemediation message', () => {
    const scenarios = [
      deploymentRemediation(undefined, [], true)?.message,
      deploymentRemediation(undefined, [], false)?.message,
      deploymentRemediation(makeDeployment(1, 0), [], false)?.message, // no pods yet
      deploymentRemediation(makeDeployment(1, 0), [makePod('CrashLoopBackOff')], false)?.message,
      deploymentRemediation(makeDeployment(1, 0), [makePod('ImagePullBackOff')], false)?.message,
      deploymentRemediation(makeDeployment(2, 1), [makePod(), makePod()], false)?.message,
      deploymentRemediation(makeDeployment(2, 0), [makePod('Pending')], false)?.message,
    ];
    for (const message of scenarios) {
      expect(message).toBeDefined();
      expect(keys).toContain(message);
    }
  });

  it('enumerates the regoWarning message', () => {
    const message = regoWarning('package policy\nallow := true');
    expect(message).toBeDefined();
    expect(keys).toContain(message);
  });

  it('enumerates the resourcePolicyWarning profile-mismatch message', () => {
    const message = resourcePolicyWarning('Restricted')(PERMISSIVE_RESOURCE_POLICY);
    expect(message).toBeDefined();
    expect(keys).toContain(message);
  });

  it('lands every enumerated key in the English catalog', () => {
    for (const key of keys) {
      expect(catalog[key]).toBeDefined();
    }
  });
});
