// ---------------------------------------------------------------------------
// Starter Rego template + a lightweight validator for the Policies tab.
//
// Trustee's attestation/resource policies are Rego. A bare textarea offers no
// starting point and accepts anything, so a typo'd policy is only caught when the
// operator/KBS later rejects it. For the RESOURCE policy we offer a single
// Permissive starter (it matches the operator's Permissive template) plus a
// shallow structural check (balanced braces/brackets, a package clause) — not a
// full Rego parser, just enough to catch obvious mistakes before the patch.
//
// We deliberately offer NO starter for the CPU/GPU attestation policies, and no
// "Restricted" resource starter:
//   * The operator owns one attestation-policy template per profile and generates
//     the correct EAR-emitting policy itself (profileType is a TrusteeConfig-level
//     property, not something the plugin should re-template). A plugin "Restricted"
//     attestation starter that emits a `default allow` rule would actually BREAK
//     EAR attestation, because the operator's real policies emit `trust_claims`.
//   * The old plugin "Restricted" resource starter checked `submods.cpu` (not the
//     real claim path) and ignored GPU, diverging from the operator's generated
//     Restricted resource policy. We drop it to avoid confusing, wrong output.
// ---------------------------------------------------------------------------

/** A permissive resource policy: allow every attested client to fetch secrets. */
export const PERMISSIVE_RESOURCE_POLICY = `package policy

default allow = true
`;

export interface RegoTemplate {
  /** Stable id (for React keys). */
  id: string;
  label: string;
  value: string;
}

/**
 * Templates offered for a policy, keyed by the policy's ConfigMap suffix. Only the
 * resource policy gets a starter (Permissive, matching the operator template); the
 * CPU/GPU attestation policies get none — the operator generates the correct
 * EAR-emitting policy for both profiles and the plugin must not re-template it.
 */
export const regoTemplatesForPolicy = (suffix: string): RegoTemplate[] => {
  if (suffix === 'resource-policy') {
    return [{ id: 'permissive', label: 'Permissive', value: PERMISSIVE_RESOURCE_POLICY }];
  }
  return [];
};

/**
 * Shallow Rego validation. Returns an error message, or undefined when the text
 * passes the basic checks. Not a full parser — guards the common mistakes (empty,
 * no package clause, unbalanced braces/brackets/parens).
 */
export const validateRego = (text: string): string | undefined => {
  const src = text.trim();
  if (src === '') return 'Policy is empty.';
  if (!/^\s*package\s+\S+/m.test(src)) return 'Missing a "package" declaration.';

  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const opens = new Set(['(', '[', '{']);
  const stack: string[] = [];
  // Track string context so braces inside strings don't count. Rego strings use
  // double quotes and backtick raw strings.
  let inStr: '"' | '`' | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\' && inStr === '"') {
        i++; // skip the escaped char
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '#') {
      // Skip to end of line (comment).
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (opens.has(ch)) stack.push(ch);
    else if (ch in pairs) {
      if (stack.pop() !== pairs[ch]) return `Unbalanced "${ch}".`;
    }
  }
  if (inStr) return 'Unterminated string literal.';
  if (stack.length > 0) return `Unbalanced "${stack[stack.length - 1]}" — missing closing bracket.`;
  return undefined;
};

const DEFAULT_ALLOW_RE = /^\s*default\s+allow\s*=/m;
const PERMISSIVE_ALLOW_RE = /^\s*default\s+allow\s*=\s*true\b/m;

/**
 * Non-blocking warning for a RESOURCE policy. Returns a warning string when the
 * policy has no `default allow` rule — the most common cause of Trustee silently
 * denying every request. Returns undefined when ok.
 *
 * This is meaningful only for the resource policy: the CPU/GPU attestation
 * policies emit an EAR appraisal (a `trust_claims` set), not an `allow` rule, so
 * the Policies tab deliberately does not run this check against them (it wires
 * `warn` only to the resource-policy editor) rather than relying on a fragile
 * content heuristic to tell the two apart.
 */
export const regoWarning = (text: string): string | undefined => {
  const src = text.trim();
  if (src === '') return undefined;
  if (!DEFAULT_ALLOW_RE.test(src)) {
    return 'No "default allow" rule found. Without it, Trustee silently denies every request. Add "default allow = true" (permissive) or "default allow = false" (restrictive) to set the baseline.';
  }
  return undefined;
};

/**
 * Warning builder for the resource-policy editor. Runs {@link regoWarning}, and
 * additionally flags a profile mismatch: saving a permissive resource policy
 * (`default allow = true`) while the TrusteeConfig profile is Restricted silently
 * weakens attestation to permissive without changing `spec.profileType`. The
 * warning is non-blocking (Save stays enabled) — it only surfaces the downgrade so
 * it is a deliberate choice, not an accident of clicking the Permissive starter.
 */
export const resourcePolicyWarning =
  (profileType?: string) =>
  (text: string): string | undefined => {
    const base = regoWarning(text);
    if (base) return base;
    if (profileType === 'Restricted' && PERMISSIVE_ALLOW_RE.test(text.trim())) {
      return 'This resource policy allows every attested client (default allow = true), but the TrusteeConfig profile is Restricted. Saving it weakens attestation to permissive while spec.profileType still says Restricted — change the profile too if this is intended.';
    }
    return undefined;
  };
