import type { FC } from 'react';
import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';

/**
 * Legacy pod action target: /trustee/verify/:ns/:name
 * Redirects to the attestation overview with query params so the matching
 * workload row auto-expands.
 */
const TrusteeVerifyRedirect: FC = () => {
  const navigate = useNavigate();
  const { ns, name } = useParams<{ ns: string; name: string }>();

  useEffect(() => {
    const namespace = ns?.trim() ?? '';
    const podName = name?.trim() ?? '';
    if (namespace && podName) {
      void navigate(
        `/trustee?namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(podName)}`,
        {
          replace: true,
        },
      );
      return;
    }
    void navigate('/trustee', { replace: true });
  }, [navigate, ns, name]);

  return null;
};

export default TrusteeVerifyRedirect;
