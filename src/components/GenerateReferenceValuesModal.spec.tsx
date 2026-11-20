/**
 * Focused regression tests for the XFAM default's fallback presentation (F-2).
 *
 * On Granite Rapids TDX hardware NFD's cpuid allow-list can omit the
 * AVX512F/AMX labels, so the detected default degenerates to the baseline
 * `x87,sse,avx` — a value that does NOT represent the node. The modal must
 * present that as a fallback requiring verification (warning helper), never
 * as a verified hardware reading, and editing the field must clear the
 * warning while keeping the value usable.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import GenerateReferenceValuesModal from './GenerateReferenceValuesModal';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  ResourceLink: (props: { name?: string }) => <span>{props.name}</span>,
  k8sCreate: jest.fn().mockResolvedValue({}),
  k8sDelete: jest.fn().mockRejectedValue(new Error('NotFound')),
  k8sGet: jest.fn().mockResolvedValue(undefined),
  useK8sWatchResource: () => [undefined, true, undefined],
  useAccessReview: () => [true, false],
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const FALLBACK_MARKER = 'This is a fallback, not a verified reading of the node';
const VERIFIED_MARKER = 'detected from the node’s NFD cpuid labels';

const renderModal = (props?: { defaultXfam?: string; defaultXfamVerified?: boolean }) =>
  render(
    <GenerateReferenceValuesModal
      trusteeConfigName="trustee-config"
      namespace="trustee-operator-system"
      tee="tdx"
      defaultOcpVersion="4.22.22"
      onClose={() => undefined}
      {...props}
    />,
  );

const xfamInput = () => screen.getByLabelText<HTMLInputElement>(/Allowed XFAM features/);

test('an unverified detected default is presented as a fallback requiring verification', () => {
  // The F-2 case: NFD published cpuid labels but no AVX512F/AMX, so the
  // detection returned the baseline with extendedFeaturesObserved=false.
  renderModal({ defaultXfam: 'x87,sse,avx' });

  expect(xfamInput().value).toBe('x87,sse,avx');
  expect(screen.getByText(new RegExp(FALLBACK_MARKER))).toBeTruthy();
  expect(screen.queryByText(new RegExp(VERIFIED_MARKER))).toBeNull();
});

test('the hardcoded baseline (no detection at all) is also presented as a fallback', () => {
  renderModal();

  expect(xfamInput().value).toBe('x87,sse,avx');
  expect(screen.getByText(new RegExp(FALLBACK_MARKER))).toBeTruthy();
});

test('a default from labels that observed AVX-512/AMX is presented as detected', () => {
  renderModal({
    defaultXfam: 'x87,sse,avx,avx512,pkru,amx',
    defaultXfamVerified: true,
  });

  expect(xfamInput().value).toBe('x87,sse,avx,avx512,pkru,amx');
  expect(screen.getByText(new RegExp(VERIFIED_MARKER))).toBeTruthy();
  expect(screen.queryByText(new RegExp(FALLBACK_MARKER))).toBeNull();
});

test('editing the field clears the fallback warning — manual entry stays usable', () => {
  renderModal({ defaultXfam: 'x87,sse,avx' });

  fireEvent.change(xfamInput(), { target: { value: 'avx512,pkru,amx' } });

  expect(xfamInput().value).toBe('avx512,pkru,amx');
  expect(screen.queryByText(new RegExp(FALLBACK_MARKER))).toBeNull();
  // The neutral helper is back and Generate stays available for the edit.
  expect(screen.getByText(new RegExp(VERIFIED_MARKER))).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: /Generate/ }).disabled).toBe(false);
});
