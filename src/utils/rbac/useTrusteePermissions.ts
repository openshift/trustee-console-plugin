import { useAccessReview } from '@openshift-console/dynamic-plugin-sdk';
import { TRUSTEE_NAMESPACE } from '../../k8s/resources';

export const useTrusteePermissions = (namespace?: string) => {
  const [canCreateTrusteeConfig, loadingTc] = useAccessReview({
    group: 'confidentialcontainers.org',
    resource: 'trusteeconfigs',
    namespace: namespace || TRUSTEE_NAMESPACE,
    verb: 'create',
  });

  return {
    canCreateTrusteeConfig,
    isLoading: loadingTc,
  };
};

export const useCanPatchConfigMap = (name?: string, namespace?: string) => {
  const [allowed, loading] = useAccessReview({
    group: '',
    resource: 'configmaps',
    namespace: namespace || TRUSTEE_NAMESPACE,
    name,
    verb: 'patch',
  });
  return { allowed, loading };
};

/**
 * Whether the user can write (create + delete) a specific ConfigMap. Used to gate
 * actions that replace a ConfigMap wholesale (delete-then-create) rather than patch
 * it, where `patch` permission alone would misgate create/delete-only grants.
 */
export const useCanWriteConfigMap = (name?: string, namespace?: string) => {
  // A create is a POST to the collection, whose authorization attributes carry no
  // resource name — so the create review must omit `name`, or a `resourceNames`-
  // restricted rule would answer a question the real request never asks. The delete
  // acts on the named object, so it keeps `name`.
  const [canCreate, loadingCreate] = useAccessReview({
    group: '',
    resource: 'configmaps',
    namespace: namespace || TRUSTEE_NAMESPACE,
    verb: 'create',
  });
  const [canDelete, loadingDelete] = useAccessReview({
    group: '',
    resource: 'configmaps',
    namespace: namespace || TRUSTEE_NAMESPACE,
    name,
    verb: 'delete',
  });
  return { allowed: canCreate && canDelete, loading: loadingCreate || loadingDelete };
};

export const useCanCreateSecret = (namespace?: string) => {
  const [allowed, loading] = useAccessReview({
    group: '',
    resource: 'secrets',
    namespace: namespace || TRUSTEE_NAMESPACE,
    verb: 'create',
  });
  return { allowed, loading };
};

export const useCanCreateJob = (namespace?: string) => {
  const [allowed, loading] = useAccessReview({
    group: 'batch',
    resource: 'jobs',
    namespace: namespace || TRUSTEE_NAMESPACE,
    verb: 'create',
  });
  return { allowed, loading };
};
