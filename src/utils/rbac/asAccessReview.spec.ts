import type { K8sModel } from '@openshift-console/dynamic-plugin-sdk';
import { asAccessReview } from './asAccessReview';

const fakeModel: K8sModel = {
  apiVersion: 'v1alpha1',
  apiGroup: 'confidentialcontainers.org',
  kind: 'TrusteeConfig',
  plural: 'trusteeconfigs',
  label: 'TrusteeConfig',
  labelPlural: 'TrusteeConfigs',
  abbr: 'TC',
  namespaced: true,
};

describe('asAccessReview', () => {
  it('builds AccessReviewResourceAttributes from a model, object, and verb', () => {
    const result = asAccessReview(
      fakeModel,
      { metadata: { name: 'tc-1', namespace: 'ns-a' } },
      'create',
    );
    expect(result).toEqual({
      group: 'confidentialcontainers.org',
      resource: 'trusteeconfigs',
      name: 'tc-1',
      namespace: 'ns-a',
      verb: 'create',
      subresource: undefined,
    });
  });

  it('returns null when the object is undefined', () => {
    expect(asAccessReview(fakeModel, undefined, 'get')).toBeNull();
  });

  it('includes subresource when provided', () => {
    const result = asAccessReview(
      fakeModel,
      { metadata: { name: 'tc-1', namespace: 'ns-a' } },
      'get',
      'status',
    );
    expect(result?.subresource).toBe('status');
  });

  it('handles a model with no apiGroup (core resources)', () => {
    const coreModel: K8sModel = {
      ...fakeModel,
      apiGroup: undefined,
      plural: 'configmaps',
    };
    const result = asAccessReview(
      coreModel,
      { metadata: { name: 'cm', namespace: 'default' } },
      'patch',
    );
    expect(result?.group).toBe('');
  });
});
