import type { FC } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Content, Gallery, PageSection } from '@patternfly/react-core';
import ConfigMapEditor from '../shared/ConfigMapEditor';
import { regoTemplatesForPolicy, validateRego, resourcePolicyWarning } from '../../utils/rego';
import { useCanPatchConfigMap } from '../../utils/rbac/useTrusteePermissions';
import type { TrusteeTabProps } from './types';
import '../trustee.css';

/**
 * One policy editor card. Each policy is a separate ConfigMap, so the patch
 * permission has to be checked against that card's own ConfigMap — a grant
 * scoped to one policy must not enable (or disable) the editors for the others.
 */
const PolicyEditorCard: FC<{
  namespace: string;
  configMapName: string;
  suffix: string;
  /** The ConfigMap data key the operator writes this policy under. */
  dataKey: string;
  title: string;
  description: string;
  /**
   * Non-blocking content warning. Only the resource-policy editor sets one — the
   * CPU/GPU attestation policies emit EAR trust claims (no `allow` rule), so the
   * missing-`default allow` check does not apply to them.
   */
  warn?: (draft: string) => string | undefined;
}> = ({ namespace, configMapName, suffix, dataKey, title, description, warn }) => {
  const { allowed: canPatch, loading: rbacLoading } = useCanPatchConfigMap(
    configMapName,
    namespace,
  );
  return (
    <ConfigMapEditor
      namespace={namespace}
      configMapName={configMapName}
      title={title}
      description={description}
      preferredKey={dataKey}
      templates={regoTemplatesForPolicy(suffix)}
      validate={validateRego}
      warn={warn}
      editable={!rbacLoading && canPatch}
    />
  );
};

/** Edit the Rego policies the operator generates from a TrusteeConfig. */
const TrusteePoliciesTab: FC<TrusteeTabProps> = ({ obj }) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const name = obj?.metadata?.name;
  const namespace = obj?.metadata?.namespace ?? '';
  const profileType = obj?.spec?.profileType;

  if (!name) {
    return (
      <PageSection>
        <Alert variant="info" isInline title={t('No TrusteeConfig selected')} />
      </PageSection>
    );
  }

  const policies = [
    {
      suffix: 'attestation-policy-cpu',
      dataKey: 'default_cpu.rego',
      title: t('CPU attestation policy'),
      desc: t(
        'Rules the Attestation Service applies to CPU TEE evidence (Intel TDX / AMD SEV-SNP).',
      ),
    },
    {
      suffix: 'attestation-policy-gpu',
      dataKey: 'default_gpu.rego',
      title: t('GPU attestation policy'),
      desc: t('Attestation rules for confidential GPU evidence.'),
    },
    {
      suffix: 'resource-policy',
      dataKey: 'resource-policy.rego',
      title: t('Resource policy'),
      desc: t('Authorizes which secrets an attested client may retrieve after attestation.'),
    },
  ];

  return (
    <PageSection>
      <Content component="p" className="trustee-openshift-console-plugin__mb">
        {t(
          'The operator generates working default policies from your TrusteeConfig — edit them here only to customize trust decisions. Policies are written in Rego.',
        )}
      </Content>
      <Content
        component="p"
        className="trustee-openshift-console-plugin__mb trustee-openshift-console-plugin__muted"
      >
        {t(
          'The attestation policies (CPU and GPU) decide whether a workload’s TEE evidence is trusted; the resource policy then decides which secrets a trusted workload may retrieve. The profile (TrusteeConfig spec.profileType) selects the defaults the operator generates when Trustee is first created — chiefly the resource policy (Permissive allows any attested client; Restricted requires an affirming EAR result) and the KBS configuration. Both profiles use the same CPU/GPU attestation templates. The operator does not regenerate any policy ConfigMap that already exists, so changing the profile later leaves these policies as they are.',
        )}
      </Content>
      <Gallery hasGutter minWidths={{ default: '480px' }}>
        {policies.map((p) => (
          <PolicyEditorCard
            key={p.suffix}
            namespace={namespace}
            configMapName={`${name}-${p.suffix}`}
            suffix={p.suffix}
            dataKey={p.dataKey}
            title={p.title}
            description={p.desc}
            warn={p.suffix === 'resource-policy' ? resourcePolicyWarning(profileType) : undefined}
          />
        ))}
      </Gallery>
    </PageSection>
  );
};

export default TrusteePoliciesTab;
