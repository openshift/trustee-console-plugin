import type { FC } from 'react';
import { Navigate, useLocation } from 'react-router';

/**
 * The console marks a nav item active on a segment-prefix match, so an Overview nav item
 * pointing at "/trustee" is also highlighted on every "/trustee/*" page. The Overview nav
 * item therefore targets "/trustee/overview" (which is not a prefix of any sibling), and
 * this route keeps legacy "/trustee" links — the deploy wizard and the pod-action verify
 * redirect, including its ?namespace=&name= query — working.
 */
const TrusteeOverviewRedirect: FC = () => {
  const { search, hash } = useLocation();
  return <Navigate to={`/trustee/overview${search}${hash}`} replace />;
};

export default TrusteeOverviewRedirect;
