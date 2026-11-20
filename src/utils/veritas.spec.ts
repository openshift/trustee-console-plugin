import { buildManualVeritasCommands, buildVeritasScript, generationResourceNames } from './veritas';
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

  it('renders veritas manifest to JSON instead of applying it', () => {
    // veritas names its own ConfigMap (rvps-reference-values /
    // trusteeconfig-rvps-reference-values) — never this TrusteeConfig's
    // operator-managed one — so the manifest must be merged, never applied.
    const script = buildVeritasScript(opts);
    expect(script).toContain(
      'oc create -f /tmp/out/rvps-reference-values.yaml --dry-run=client -o json > /tmp/rv-verbatim.json',
    );
    expect(script).not.toContain('oc apply');
  });

  it('accepts either veritas data key and payload shape', () => {
    // Released coco-tools <= 1.12 writes the v1.1 array under
    // `reference-values.json`; upstream main writes the operator's
    // `reference_value` map. The merge helper must accept both.
    const script = buildVeritasScript(opts);
    expect(script).toContain('vdata.get("reference_value") or vdata.get("reference-values.json")');
    expect(script).toContain('isinstance(veritas_raw, list)');
    expect(script).toContain('isinstance(veritas_raw, dict)');
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

describe('buildManualVeritasCommands', () => {
  it('runs the same veritas flags as the in-cluster Job', () => {
    const cmds = buildManualVeritasCommands({
      tee: 'tdx',
      ocpVersion: '4.22.19',
      rvpsConfigMap: 'tc-rvps-reference-values',
      namespace: 'trustee-ns',
    });
    expect(cmds).toContain('podman run --rm');
    expect(cmds).toContain('quay.io/openshift_sandboxed_containers/coco-tools:1.12');
    expect(cmds).toContain('veritas --platform baremetal --tee tdx --ocp-version 4.22.19');
    expect(cmds).toContain('--authfile /auth/.dockerconfigjson');
    // Defaults mirror the in-cluster generator's XFAM default.
    expect(cmds).toContain('--hw-xfam-allow x87 --hw-xfam-allow sse --hw-xfam-allow avx');
  });

  it('merges into the operator-managed ConfigMap — never applies veritas manifest', () => {
    const cmds = buildManualVeritasCommands({
      tee: 'snp',
      ocpVersion: '4.22.19',
      rvpsConfigMap: 'tc-rvps-reference-values',
      namespace: 'trustee-ns',
    });
    expect(cmds).toContain('oc patch configmap tc-rvps-reference-values -n trustee-ns --type json');
    expect(cmds).toContain(
      'oc get configmap tc-rvps-reference-values -n trustee-ns -o json > rv-cm.json',
    );
    // The whole point of the fix: no `oc apply` of veritas's own manifest
    // (the prose warns against it — so assert on command lines, not prose).
    expect(cmds.split('\n').findIndex((l) => l.trim().startsWith('oc apply'))).toBe(-1);
    // Same merge helper as the Job, so the flows cannot drift.
    expect(cmds).toContain("cat > merge-rv.py <<'PYEOF'");
    expect(cmds).toContain('merged.update(fresh)');
    // Mounts a host dir so veritas's output survives the container.
    expect(cmds).toContain('-v "$PWD/veritas-out:/tmp/out:Z"');
  });

  it('keeps a placeholder OpenShift version when the cluster version is unknown', () => {
    const cmds = buildManualVeritasCommands({
      tee: 'tdx',
      rvpsConfigMap: 'tc-rvps-reference-values',
      namespace: 'trustee-ns',
    });
    expect(cmds).toContain('--ocp-version <your-ocp-version>');
  });
});

describe('generationResourceNames', () => {
  it('derives every per-run resource name from the TrusteeConfig name', () => {
    const names = generationResourceNames('trustee-config');
    expect(names.prefix).toBe('trustee-config-rvps-gen');
    expect(names.pullSecret).toBe('trustee-config-rvps-gen-pull');
    expect(names.initdataConfigMap).toBe('trustee-config-rvps-gen-initdata');
  });

  it('keeps the per-run names distinct from the operator-managed RVPS ConfigMap', () => {
    // The cleanup path deletes these objects — they must never collide with
    // anything the operator or another flow owns.
    const names = generationResourceNames('tc');
    expect(names.pullSecret).not.toContain('rvps-reference-values');
    expect(names.initdataConfigMap).not.toContain('rvps-reference-values');
  });
});
