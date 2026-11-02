import type { FC } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { k8sCreate, k8sDelete, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Button,
  Content,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  TextInput,
} from '@patternfly/react-core';
import {
  JobGVK,
  JobModel,
  RoleBindingModel,
  RoleModel,
  ServiceAccountModel,
  UBI9_IMAGE,
} from '../k8s/resources';
import type { JobKind } from '../k8s/types';
import {
  buildAttestationTokenSecretScript,
  buildHttpsTlsSecretScript,
  isValidSecretName,
} from '../utils/secretGeneration';
import { useCanCreateJob } from '../utils/rbac/useTrusteePermissions';
import PermissionHint from '../utils/rbac/PermissionHint';

const PREFIX = 'trustee-openshift-console-plugin';

const isNotFound = (e: unknown): boolean =>
  /not found|notfound|404/i.test(e instanceof Error ? e.message : String(e));

/** Which KBS secret the modal mints. Both are kubernetes.io/tls Secrets. */
export type SecretPurpose = 'https' | 'token';

interface Props {
  trusteeConfigName: string;
  namespace: string;
  ingressDomain?: string;
  defaultSecretName?: string;
  /** HTTPS server cert (default) or the attestation-token signing cert. */
  purpose?: SecretPurpose;
  onCreated: (secretName: string) => void;
  onClose: () => void;
}

/**
 * The in-cluster Job: openssl mints the certificate material and curl
 * server-side-applies it as a kubernetes.io/tls Secret using the Job's own
 * ServiceAccount token. The private key is generated inside the cluster and never
 * reaches the browser.
 *
 * HTTPS (default): a CA plus an end-entity server leaf it signs. That chain is
 * required — the in-guest Confidential Data Hub validates the KBS with
 * rustls/webpki, which REJECTS a self-signed CA:TRUE certificate presented as the
 * server leaf. The workload pins the CA (the secret's ca.crt) in its initdata.
 *
 * Token: a self-signed ECDSA P-256 certificate/key in PKCS8 — the algorithm and
 * encoding the Trustee operator expects for signing and verifying the short-lived
 * attestation token the KBS issues after evidence matches the reference values.
 */
const GenerateTlsSecretModal: FC<Props> = ({
  trusteeConfigName,
  namespace,
  ingressDomain,
  defaultSecretName,
  purpose = 'https',
  onCreated,
  onClose,
}) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const { allowed: canCreateJob, loading: rbacLoading } = useCanCreateJob(namespace);
  const isToken = purpose === 'token';
  const base = trusteeConfigName || 'kbs';

  const [secretName, setSecretName] = useState(
    defaultSecretName || `${base}-${isToken ? 'token-cert' : 'https-tls'}`,
  );
  const [cn, setCn] = useState(isToken ? `${base}-token` : `kbs-service.${namespace}.svc`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [started, setStarted] = useState(false);
  const [done, setDone] = useState(false);

  // SANs: the in-cluster Service DNS the user typed, plus the apps wildcard so any
  // passthrough Route on this cluster's ingress domain validates (hub-and-spoke).
  const san = useMemo(() => {
    const names = [`DNS:${cn.trim()}`];
    if (ingressDomain) names.push(`DNS:*.${ingressDomain}`);
    return names.join(',');
  }, [cn, ingressDomain]);

  // Distinct Job names so an HTTPS run and a token run never collide.
  const P = `${base}-${isToken ? 'token' : 'tls'}-gen`;
  const secretValid = isValidSecretName(secretName.trim());
  const valid = secretValid && cn.trim() !== '';

  const [job] = useK8sWatchResource<JobKind>(
    started ? { groupVersionKind: JobGVK, name: P, namespace } : null,
  ) as [JobKind | undefined, boolean, unknown];

  const active = (job?.status?.active ?? 0) > 0;
  const succeeded = (job?.status?.succeeded ?? 0) > 0;
  const failed =
    (job?.status?.failed ?? 0) > 0 ||
    (job?.status?.conditions ?? []).some((c) => c.type === 'Failed' && c.status === 'True');

  // Once the Job succeeds, hand the secret name back to the wizard (once).
  useEffect(() => {
    if (succeeded && !done) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDone(true);
      onCreated(secretName.trim());
    }
  }, [succeeded, done, onCreated, secretName]);

  const onGenerate = async () => {
    setBusy(true);
    setError('');
    try {
      const sa = {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name: P, namespace },
      };
      const role = {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'Role',
        metadata: { name: P, namespace },
        rules: [
          {
            apiGroups: [''],
            resources: ['secrets'],
            verbs: ['get', 'create', 'patch', 'update'],
          },
        ],
      };
      const rb = {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: { name: P, namespace },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: P },
        subjects: [{ kind: 'ServiceAccount', name: P, namespace }],
      };
      // Idempotent: recreate the SA/Role/RoleBinding so reruns start clean.
      for (const [model, resource] of [
        [ServiceAccountModel, sa],
        [RoleModel, role],
        [RoleBindingModel, rb],
      ] as const) {
        try {
          await k8sDelete({ model, resource });
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
        await k8sCreate({ model, data: resource });
      }

      const script = (isToken ? buildAttestationTokenSecretScript : buildHttpsTlsSecretScript)({
        secret: secretName.trim(),
        cn: cn.trim(),
        san,
        namespace,
      });
      const jobResource: JobKind & Record<string, unknown> = {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: P, namespace },
        spec: {
          backoffLimit: 1,
          template: {
            spec: {
              serviceAccountName: P,
              restartPolicy: 'Never',
              containers: [
                {
                  name: 'openssl',
                  image: UBI9_IMAGE,
                  env: [{ name: 'HOME', value: '/tmp' }],
                  command: ['bash', '-c'],
                  args: [script],
                },
              ],
            },
          },
        },
      };
      try {
        await k8sDelete({ model: JobModel, resource: jobResource });
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      await k8sCreate({ model: JobModel, data: jobResource });
      setStarted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const title = isToken ? t('Generate attestation token secret') : t('Generate TLS secret');

  return (
    <Modal isOpen variant="medium" onClose={onClose} aria-label={title}>
      <ModalHeader title={title} />
      <ModalBody>
        <Form>
          <Alert variant="info" isInline title={t('How this works')} className={`${PREFIX}__mb`}>
            {isToken
              ? t(
                  'Runs a short in-cluster Job that mints a self-signed ECDSA P-256 certificate and its private key in PKCS8 (openssl), stored as a kubernetes.io/tls Secret with tls.crt and tls.key. KBS signs the attestation token it issues with this key and verifies it with the certificate, so a workload cannot forge a token to bypass the reference-value checks. The private key is created inside the cluster and never reaches your browser.',
                )
              : t(
                  'Runs a short in-cluster Job that mints a CA and a server certificate it signs (openssl), stored as a kubernetes.io/tls Secret: tls.crt + tls.key are the leaf KBS serves, ca.crt is the CA the workload pins in its initdata. A proper CA→leaf chain is required — the in-guest Confidential Data Hub rejects a single self-signed certificate. The private key is created inside the cluster and never reaches your browser.',
                )}
          </Alert>

          <FormGroup label={t('Secret name')} isRequired fieldId="tls-secret">
            <TextInput
              id="tls-secret"
              value={secretName}
              isDisabled={started}
              validated={secretValid ? 'default' : 'error'}
              onChange={(_e, v) => {
                setSecretName(v);
              }}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem variant={secretValid ? 'default' : 'error'}>
                  {secretValid
                    ? isToken
                      ? t(
                          'Created in the {{nsName}} namespace; referenced as the attestation token verification secret.',
                          { nsName: namespace },
                        )
                      : t(
                          'Created in the {{nsName}} namespace; referenced as the HTTPS TLS secret.',
                          {
                            nsName: namespace,
                          },
                        )
                    : t('Must be a lowercase DNS name (a–z, 0–9, -).')}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          <FormGroup label={t('Certificate hostname (CN)')} isRequired fieldId="tls-cn">
            <TextInput
              id="tls-cn"
              value={cn}
              isDisabled={started}
              onChange={(_e, v) => {
                setCn(v);
              }}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  {isToken
                    ? t(
                        'Subject and SAN of the self-signed certificate. Only its public key is used to verify the tokens KBS issues; the hostname is not contacted.',
                      )
                    : ingressDomain
                      ? t(
                          'SAN: {{cn}} (in-cluster) and *.{{domain}} (covers Routes for remote spokes).',
                          {
                            cn: cn.trim(),
                            domain: ingressDomain,
                          },
                        )
                      : t(
                          'Subject and SAN of the cert. Defaults to the in-cluster KBS Service DNS.',
                        )}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          {started && !failed && !succeeded && (
            <Alert variant="info" isInline title={t('Generating…')}>
              {active ? t('The openssl Job is running.') : t('Waiting for the Job to start.')}
            </Alert>
          )}
          {succeeded && (
            <Alert
              variant="success"
              isInline
              title={isToken ? t('Attestation token secret created') : t('TLS secret created')}
            >
              {t('Secret {{name}} is ready and has been filled into the form.', {
                name: secretName.trim(),
              })}
            </Alert>
          )}
          {failed && (
            <Alert variant="danger" isInline title={t('The generator Job failed')}>
              {t('Check the Job {{job}} in {{nsName}} for details.', { job: P, nsName: namespace })}
            </Alert>
          )}
          {error && (
            <Alert variant="danger" isInline title={t('Could not start the generator')}>
              {error}
            </Alert>
          )}
          <Content component="small" className={`${PREFIX}__muted`}>
            {t('Leaves a Job and its ServiceAccount/Role/RoleBinding named {{p}} behind.', {
              p: P,
            })}
          </Content>
          <PermissionHint allowed={canCreateJob} loading={rbacLoading} />
        </Form>
      </ModalBody>
      <ModalFooter>
        {!succeeded ? (
          <>
            <Button
              variant="primary"
              onClick={() => void onGenerate()}
              isLoading={busy || (started && !failed)}
              isDisabled={!valid || busy || (started && !failed) || rbacLoading || !canCreateJob}
            >
              {started && failed ? t('Retry') : t('Generate')}
            </Button>
            <Button variant="link" onClick={onClose}>
              {t('Cancel')}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            {t('Done')}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
};

export default GenerateTlsSecretModal;
