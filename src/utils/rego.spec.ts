import {
  PERMISSIVE_RESOURCE_POLICY,
  regoTemplatesForPolicy,
  regoWarning,
  resourcePolicyWarning,
  validateRego,
} from './rego';

// A trimmed excerpt of the operator's generated CPU/GPU EAR attestation policy:
// it emits `trust_claims` instead of an `allow` rule, and has no `default allow`.
const EAR_ATTESTATION_POLICY = `package policy

import rego.v1

default executables := 33
default hardware := 97

trust_claims := {
  "executables": executables,
  "hardware": hardware,
}
`;

describe('validateRego', () => {
  it('accepts the shipped permissive template', () => {
    expect(validateRego(PERMISSIVE_RESOURCE_POLICY)).toBeUndefined();
  });

  it('accepts a balanced EAR attestation policy', () => {
    expect(validateRego(EAR_ATTESTATION_POLICY)).toBeUndefined();
  });

  it('rejects an empty policy', () => {
    expect(validateRego('')).toMatch(/empty/i);
    expect(validateRego('   \n  ')).toMatch(/empty/i);
  });

  it('rejects a policy with no package clause', () => {
    expect(validateRego('default allow = true')).toMatch(/package/i);
  });

  it('rejects unbalanced braces', () => {
    expect(validateRego('package policy\nallow {\n  x == 1\n')).toMatch(/unbalanced|missing/i);
  });

  it('rejects a stray closing bracket', () => {
    expect(validateRego('package policy\nallow }\n')).toMatch(/unbalanced/i);
  });

  it('ignores braces inside strings and comments', () => {
    const policy = `package policy

# a comment with an unbalanced { brace
default msg = "a string with } and { inside"
`;
    expect(validateRego(policy)).toBeUndefined();
  });

  it('rejects an unterminated string', () => {
    expect(validateRego('package policy\nx = "oops\n')).toMatch(/string/i);
  });

  it('handles escaped quotes inside strings', () => {
    expect(validateRego('package policy\nx = "a \\" quote"\n')).toBeUndefined();
  });
});

describe('regoWarning', () => {
  it('returns undefined for the permissive resource template (has default allow)', () => {
    expect(regoWarning(PERMISSIVE_RESOURCE_POLICY)).toBeUndefined();
  });

  it('warns when a policy has no default allow rule', () => {
    const policy = 'package policy\nallow { input.ok == true }\n';
    expect(regoWarning(policy)).toMatch(/default allow/i);
  });

  it('accepts default allow = true', () => {
    expect(regoWarning('package policy\ndefault allow = true\n')).toBeUndefined();
  });

  it('accepts default allow = false', () => {
    expect(regoWarning('package policy\ndefault allow = false\n')).toBeUndefined();
  });

  it('returns undefined for empty input (no false positive)', () => {
    expect(regoWarning('')).toBeUndefined();
  });
});

describe('resourcePolicyWarning', () => {
  const restrictivePolicy = 'package policy\n\ndefault allow = false\n';

  it('flags a permissive policy saved under a Restricted profile', () => {
    const warn = resourcePolicyWarning('Restricted');
    expect(warn(PERMISSIVE_RESOURCE_POLICY)).toMatch(/weakens attestation to permissive/i);
  });

  it('does not flag a restrictive policy under a Restricted profile', () => {
    expect(resourcePolicyWarning('Restricted')(restrictivePolicy)).toBeUndefined();
  });

  it('does not flag a permissive policy under a Permissive profile', () => {
    expect(resourcePolicyWarning('Permissive')(PERMISSIVE_RESOURCE_POLICY)).toBeUndefined();
  });

  it('does not flag a mismatch when the profile is unknown', () => {
    expect(resourcePolicyWarning(undefined)(PERMISSIVE_RESOURCE_POLICY)).toBeUndefined();
  });

  it('still surfaces the missing-default-allow warning regardless of profile', () => {
    const noAllow = 'package policy\nallow { input.ok == true }\n';
    expect(resourcePolicyWarning('Restricted')(noAllow)).toMatch(/default allow/i);
    expect(resourcePolicyWarning('Permissive')(noAllow)).toMatch(/default allow/i);
  });
});

describe('regoTemplatesForPolicy', () => {
  it('offers only a Permissive starter for the resource policy (no Restricted)', () => {
    const tpls = regoTemplatesForPolicy('resource-policy');
    expect(tpls.map((t) => t.id)).toEqual(['permissive']);
    expect(tpls[0].value).toBe(PERMISSIVE_RESOURCE_POLICY);
  });

  it('offers no starter buttons for the CPU attestation policy', () => {
    expect(regoTemplatesForPolicy('attestation-policy-cpu')).toEqual([]);
  });

  it('offers no starter buttons for the GPU attestation policy', () => {
    expect(regoTemplatesForPolicy('attestation-policy-gpu')).toEqual([]);
  });
});
