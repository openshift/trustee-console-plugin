import { buildVeritasScript } from './veritas';
import { RVPS_REFERENCE_VALUES_KEY, RVPS_REFERENCE_VALUES_LEGACY_KEY } from '../k8s/resources';

const opts = {
  tee: 'tdx' as const,
  ocpVersion: '4.22.0',
  gpu: false,
  xfamFeatures: ['x87', 'sse'],
  rvpsConfigMap: 'tc-rvps-reference-values',
  namespace: 'trustee-ns',
  hasInitdata: false,
};

describe('buildVeritasScript', () => {
  it('runs veritas for the given TEE/OCP version and patches the operator ConfigMap', () => {
    const script = buildVeritasScript(opts);
    expect(script).toContain('set -e');
    expect(script).toContain('veritas --platform baremetal --tee tdx --ocp-version 4.22.0');
    expect(script).toContain('--hw-xfam-allow x87 --hw-xfam-allow sse');
    expect(script).not.toContain('--gpu');
    expect(script).not.toContain('--initdata');
    expect(script).toContain(
      'oc patch configmap tc-rvps-reference-values -n trustee-ns --type json',
    );
    expect(script).toContain('echo "PATCHED tc-rvps-reference-values"');
  });

  it('propagates the gpu and initdata flags', () => {
    const script = buildVeritasScript({ ...opts, gpu: true, hasInitdata: true });
    expect(script).toContain('--gpu');
    expect(script).toContain('--initdata /initdata/initdata.toml');
  });

  it("extracts veritas's own artifact under its reference-values.json key", () => {
    // veritas renders its manifest with the data key `reference-values.json` —
    // that is the SOURCE artifact key and must not be renamed.
    const script = buildVeritasScript(opts);
    expect(script).toContain(
      `oc create -f /tmp/out/rvps-reference-values.yaml --dry-run=client -o 'jsonpath={.data.reference-values\\.json}' > /tmp/rv.json`,
    );
  });

  it('merges into the destination key instead of replacing it', () => {
    const script = buildVeritasScript(opts);
    // The merge helper starts from the ConfigMap's existing data and overlays the
    // fresh veritas values (which win same-name collisions), so manually
    // registered entries under other names survive a regeneration.
    expect(script).toContain('merged.update(fresh)');
    expect(script).toContain(`patch = [{"op": "add", "path": "/data/${RVPS_REFERENCE_VALUES_KEY}"`);
    // A present legacy key is kept in sync, mirroring registerReferenceValue.
    expect(script).toContain(`"/data/${RVPS_REFERENCE_VALUES_LEGACY_KEY}"`);
    // ... and data the helper cannot parse is never clobbered.
    expect(script).toContain('refusing to overwrite it');
  });

  it("converts veritas's array payload to the RVPS map format", () => {
    const script = buildVeritasScript(opts);
    // An array payload (veritas's v1.1 wire format) is converted in the Job:
    // each entry becomes name → URL-safe-base64 compact JSON (RVPS local_json).
    expect(script).toContain('isinstance(veritas_raw, list)');
    expect(script).toContain('base64.urlsafe_b64encode');
    expect(script).toContain('separators=(",", ":")');
  });

  it('guards the patch with a resourceVersion test and retries on conflict', () => {
    const script = buildVeritasScript(opts);
    // JSON Patch otherwise has no optimistic concurrency, so two concurrent
    // writers would silently lose one side; the test op rejects the patch
    // instead, and the loop re-reads and re-merges.
    expect(script).toContain('{"op": "test", "path": "/metadata/resourceVersion"');
    expect(script).toContain('for attempt in 1 2 3');
    expect(script).toContain('exit 1');
  });
});
