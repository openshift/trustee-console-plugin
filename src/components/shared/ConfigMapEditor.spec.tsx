import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ConfigMapEditor from './ConfigMapEditor';
import {
  validateRego,
  regoWarning,
  resourcePolicyWarning,
  PERMISSIVE_RESOURCE_POLICY,
} from '../../utils/rego';

// --- SDK mock: a fixed ConfigMap watch + a spyable k8sPatch ---
const k8sPatch = jest.fn().mockResolvedValue({});
let watchResult: [unknown, boolean, unknown] = [undefined, false, null];

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ResourceLink: (props: any) => <span data-test="resource-link">{props.name}</span>,
  k8sPatch: (...args: unknown[]) => k8sPatch(...args),
  useK8sWatchResource: () => watchResult,
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const cm = (data: Record<string, string>) => ({
  apiVersion: 'v1',
  kind: 'ConfigMap',
  metadata: { name: 'tc-resource-policy', namespace: 'trustee', resourceVersion: '7' },
  data,
});

const renderResourceEditor = (overrides?: {
  templates?: { id: string; label: string; value: string }[];
  warn?: (draft: string) => string | undefined;
}) =>
  render(
    <ConfigMapEditor
      namespace="trustee"
      configMapName="tc-resource-policy"
      title="Resource policy"
      preferredKey="resource-policy.rego"
      templates={
        overrides?.templates ?? [
          { id: 'permissive', label: 'Permissive', value: PERMISSIVE_RESOURCE_POLICY },
        ]
      }
      validate={validateRego}
      warn={overrides?.warn ?? regoWarning}
      editable
    />,
  );

beforeEach(() => {
  k8sPatch.mockClear();
});

describe('ConfigMapEditor — policy buttons', () => {
  it('shows the resource-policy Permissive starter but not a Restricted one', () => {
    watchResult = [
      cm({ 'resource-policy.rego': 'package policy\n\ndefault allow = false\n' }),
      true,
      null,
    ];
    renderResourceEditor();
    expect(screen.getByRole('button', { name: 'Permissive' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restricted' })).toBeNull();
  });

  it('shows no preset buttons when the policy has no templates (CPU/GPU)', () => {
    watchResult = [
      cm({ 'default_cpu.rego': 'package policy\n\ntrust_claims := {}\n' }),
      true,
      null,
    ];
    render(
      <ConfigMapEditor
        namespace="trustee"
        configMapName="tc-attestation-policy-cpu"
        title="CPU attestation policy"
        preferredKey="default_cpu.rego"
        templates={[]}
        validate={validateRego}
        warn={regoWarning}
        editable
      />,
    );
    expect(screen.queryByRole('button', { name: 'Permissive' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restricted' })).toBeNull();
    expect(screen.queryByText('Start from a template:')).toBeNull();
  });
});

describe('ConfigMapEditor — data key selection', () => {
  it('edits the preferredKey, not the first key, when several are present', () => {
    watchResult = [
      cm({ 'other-thing': 'IGNORE ME', 'default_cpu.rego': 'THE CPU POLICY' }),
      true,
      null,
    ];
    render(
      <ConfigMapEditor
        namespace="trustee"
        configMapName="tc-attestation-policy-cpu"
        title="CPU attestation policy"
        preferredKey="default_cpu.rego"
        templates={[]}
        editable
      />,
    );
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
    expect(textarea.value).toBe('THE CPU POLICY');
  });
});

describe('ConfigMapEditor — resource-policy profile-mismatch warning', () => {
  it('warns when a Permissive policy is drafted under a Restricted profile', () => {
    const restrictive = 'package policy\n\ndefault allow = false\n';
    watchResult = [cm({ 'resource-policy.rego': restrictive }), true, null];
    renderResourceEditor({ warn: resourcePolicyWarning('Restricted') });

    // No warning until the draft actually becomes permissive.
    expect(screen.queryByText(/weakens attestation to permissive/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Permissive' }));
    expect(screen.getByText(/weakens attestation to permissive/i)).toBeTruthy();
  });

  it('does not warn when the profile is Permissive', () => {
    const restrictive = 'package policy\n\ndefault allow = false\n';
    watchResult = [cm({ 'resource-policy.rego': restrictive }), true, null];
    renderResourceEditor({ warn: resourcePolicyWarning('Permissive') });

    fireEvent.click(screen.getByRole('button', { name: 'Permissive' }));
    expect(screen.queryByText(/weakens attestation to permissive/i)).toBeNull();
  });
});

describe('ConfigMapEditor — draft, save, reset', () => {
  it('clicking a template only changes the unsaved draft (no save)', () => {
    const original = 'package policy\n\ndefault allow = false\n';
    watchResult = [cm({ 'resource-policy.rego': original }), true, null];
    renderResourceEditor();

    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
    expect(textarea.value).toBe(original);

    fireEvent.click(screen.getByRole('button', { name: 'Permissive' }));
    expect(textarea.value).toBe(PERMISSIVE_RESOURCE_POLICY);
    // The draft changed but nothing was persisted.
    expect(k8sPatch).not.toHaveBeenCalled();
  });

  it('Reset restores the loaded ConfigMap content and clears the dirty state', () => {
    const original = 'package policy\n\ndefault allow = false\n';
    watchResult = [cm({ 'resource-policy.rego': original }), true, null];
    renderResourceEditor();
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');

    fireEvent.change(textarea, { target: { value: 'package policy\n\ndefault allow = true\n' } });
    expect(textarea.value).toBe('package policy\n\ndefault allow = true\n');

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(textarea.value).toBe(original);
  });

  it('Save issues a JSON patch targeting the correct /data/<key>', async () => {
    const original = 'package policy\n\ndefault allow = false\n';
    watchResult = [cm({ 'resource-policy.rego': original }), true, null];
    renderResourceEditor();
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');

    const edited = 'package policy\n\ndefault allow = true\n';
    fireEvent.change(textarea, { target: { value: edited } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(k8sPatch).toHaveBeenCalledTimes(1);
    });
    const arg = k8sPatch.mock.calls[0][0] as {
      data: { op: string; path: string; value: string }[];
    };
    expect(arg.data[0].op).toBe('replace');
    expect(arg.data[0].path).toBe('/data/resource-policy.rego');
    expect(arg.data[0].value).toBe(edited);
  });
});
