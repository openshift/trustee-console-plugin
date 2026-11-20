// ---------------------------------------------------------------------------
// i18n keys for strings that reach t() through a variable.
//
// Some utils return human-readable English strings as data (e.g.
// deploymentRemediation's hint.message, regoWarning's warning text) and the
// consuming component translates them with t(hint.message). The i18n
// extractor only scans literal t('…') call sites, so those strings would never
// land in the translation catalog and would stay English in every other
// locale. They are enumerated here as literal t('…') calls — the extractor
// picks them up from this file, and i18nCatalog.spec.ts enforces that every
// literal key resolves through the catalog.
//
// Not imported at runtime: keep this list in sync with the string literals in
// the utils it mirrors (healthRemediation.ts, rego.ts).
// ---------------------------------------------------------------------------

/**
 * @param t identity-shaped translation function — only the literal call sites
 *        matter to the extractor; at runtime this is never invoked.
 * @returns every static string that a component passes to t() via a variable.
 */
export const i18nStaticKeys = (t: (key: string) => string): string[] => [
  // src/utils/healthRemediation.ts — deploymentRemediation() messages,
  // rendered by TrusteeHealthTab as t(hint.message).
  t(
    'The Trustee operator Deployment was not found. Verify the operator is installed from OperatorHub.',
  ),
  t(
    'The KBS Deployment was not found. The operator may not have reconciled the TrusteeConfig yet.',
  ),
  t(
    'No pods have been created yet. The operator may still be reconciling — if this persists, check the operator pod logs.',
  ),
  t(
    'A pod is crash-looping. Check pod logs for a missing TLS secret, malformed KBS config, or OOM. Click the pod link above to view logs.',
  ),
  t(
    'A pod has an image pull error. Verify the container image exists and pull secrets are configured.',
  ),
  t(
    'Some replicas are not ready. Check pod events for scheduling constraints, resource limits, or node affinity issues.',
  ),
  t('The Deployment is not fully available. Check pod status and events for details.'),
  // src/utils/rego.ts — regoWarning() / resourcePolicyWarning() messages,
  // rendered by ConfigMapEditor as t(warningText).
  t(
    'No "default allow" rule found. Without it, Trustee silently denies every request. Add "default allow = true" (permissive) or "default allow = false" (restrictive) to set the baseline.',
  ),
  t(
    'This resource policy allows every attested client (default allow = true), but the TrusteeConfig profile is Restricted. Saving it weakens attestation to permissive while spec.profileType still says Restricted — change the profile too if this is intended.',
  ),
];
