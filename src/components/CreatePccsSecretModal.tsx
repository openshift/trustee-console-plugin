import type { FC } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { k8sCreate } from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Button,
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
import { SecretModel } from '../k8s/resources';
import { useCanCreateSecret } from '../utils/rbac/useTrusteePermissions';
import PermissionHint from '../utils/rbac/PermissionHint';
import './trustee.css';

const PCCS_SECRET_NAME = 'pccs-api-key';

interface Props {
  namespace: string;
  onCreated: (secretName: string) => void;
  onClose: () => void;
}

const CreatePccsSecretModal: FC<Props> = ({ namespace, onCreated, onClose }) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const { allowed: canCreate, loading: rbacLoading } = useCanCreateSecret(namespace);

  const [secretName, setSecretName] = useState(PCCS_SECRET_NAME);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const valid = secretName.trim().length > 0 && apiKey.trim().length > 0;

  const onCreate = async () => {
    setBusy(true);
    setError('');
    try {
      await k8sCreate({
        model: SecretModel,
        data: {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: secretName.trim(), namespace },
          type: 'Opaque',
          stringData: { 'api-key': apiKey.trim() },
        },
      });
      onCreated(secretName.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal variant="medium" isOpen onClose={onClose}>
      <ModalHeader title={t('Create PCCS API key secret')} />
      <ModalBody>
        <Form>
          <PermissionHint allowed={canCreate} loading={rbacLoading} />
          <FormGroup label={t('Secret name')} isRequired fieldId="pccs-name">
            <TextInput
              id="pccs-name"
              value={secretName}
              onChange={(_e, v) => {
                setSecretName(v);
              }}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  {t('Opaque Secret created in namespace {{ns}}.', { ns: namespace })}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>
          <FormGroup label={t('PCCS API key')} isRequired fieldId="pccs-key">
            <TextInput
              id="pccs-key"
              type="password"
              value={apiKey}
              onChange={(_e, v) => {
                setApiKey(v);
              }}
              placeholder={t('Paste the API key from the Intel Trusted Services portal')}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  {t('Write-only — the key is stored as stringData and never rendered back.')}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>
          {error && (
            <Alert variant="danger" isInline title={t('Could not create Secret')}>
              {error}
            </Alert>
          )}
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button
          variant="primary"
          onClick={() => void onCreate()}
          isLoading={busy}
          isDisabled={!valid || busy || rbacLoading || !canCreate}
        >
          {t('Create')}
        </Button>
        <Button variant="link" onClick={onClose} isDisabled={busy}>
          {t('Cancel')}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

export default CreatePccsSecretModal;
