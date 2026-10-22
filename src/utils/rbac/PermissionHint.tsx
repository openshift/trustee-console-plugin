import type { FC } from 'react';
import { Alert } from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';

interface PermissionHintProps {
  allowed: boolean;
  loading?: boolean;
}

const PermissionHint: FC<PermissionHintProps> = ({ allowed, loading }) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  if (loading || allowed) return null;
  return (
    <Alert
      variant="warning"
      isInline
      title={t('Insufficient permissions')}
      className="trustee-openshift-console-plugin__mb"
    >
      {t('You do not have permission to perform this action. Contact a cluster administrator.')}
    </Alert>
  );
};

export default PermissionHint;
