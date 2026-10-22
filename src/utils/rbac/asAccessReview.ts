import type {
  AccessReviewResourceAttributes,
  K8sModel,
  K8sVerb,
} from '@openshift-console/dynamic-plugin-sdk';

interface ResourceRef {
  metadata?: { name?: string; namespace?: string };
}

export const asAccessReview = (
  model: K8sModel,
  obj: ResourceRef | undefined,
  verb: K8sVerb,
  subresource?: string,
): AccessReviewResourceAttributes | null => {
  if (!obj) return null;
  return {
    group: model.apiGroup ?? '',
    resource: model.plural,
    name: obj.metadata?.name,
    namespace: obj.metadata?.namespace,
    verb,
    subresource,
  };
};
