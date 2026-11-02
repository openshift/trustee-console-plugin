// ---------------------------------------------------------------------------
// veritas reference-value generation script.
//
// veritas renders its results as a ConfigMap manifest whose data key is
// `reference-values.json` (a plain JSON array of reference values — the v1.1
// wire format). The Trustee operator (v1.2.0+) instead mounts the
// `<tc>-rvps-reference-values` ConfigMap's `reference_value` key, whose payload
// is RVPS's local_json format: {name: URL-safe-base64 compact JSON} (see
// src/utils/referenceValues.ts). The script below therefore extracts veritas's
// artifact under its own key, converts an array payload to the current format,
// and MERGES it into the operator's ConfigMap under `reference_value` — existing
// entries under other names (e.g. a manually registered init_data value) are
// preserved; only same-name entries are refreshed (that's the point of
// regenerating after an upgrade). A present legacy `reference-values.json` key
// is kept in sync, mirroring registerReferenceValue on the plugin side.
//
// The patch is a JSON Patch guarded by a `test` on the ConfigMap's
// resourceVersion, so a concurrent write fails loudly instead of silently
// losing one side; the loop re-reads and re-merges a few times before giving up.
// ---------------------------------------------------------------------------

/**
 * Build the bash `-c` script the veritas Job runs. It generates RVPS reference
 * values for the given TEE/OCP version, extracts reference-values.json from
 * veritas's own ConfigMap manifest, converts it to the operator's current
 * `reference_value` format, merges it into the operator-generated
 * `<name>-rvps-reference-values` ConfigMap, and keeps a present legacy key in
 * sync.
 */
export const buildVeritasScript = (opts: {
  tee: 'tdx' | 'snp';
  ocpVersion: string;
  gpu: boolean;
  xfamFeatures: string[];
  rvpsConfigMap: string;
  namespace: string;
  hasInitdata: boolean;
}): string => {
  const { tee, ocpVersion, gpu, xfamFeatures, rvpsConfigMap, namespace, hasInitdata } = opts;
  const gpuFlag = gpu ? '--gpu' : '';
  const xfamFlags = xfamFeatures.map((f) => `--hw-xfam-allow ${f}`).join(' ');
  // Collapse any accidental double spaces from empty flags so the command line is clean.
  const veritasCmd = [
    'veritas --platform baremetal',
    `--tee ${tee}`,
    `--ocp-version ${ocpVersion}`,
    hasInitdata ? '--initdata /initdata/initdata.toml' : '',
    '--authfile /auth/.dockerconfigjson',
    gpuFlag,
    xfamFlags,
    '-o /tmp/out',
  ]
    .filter((s) => s.length > 0)
    .join(' ');

  return [
    'set -e',
    'mkdir -p /tmp/out',
    veritasCmd,
    // Render veritas's manifest client-side and pull out just its reference-values.json
    // artifact (veritas's own key — NOT the destination ConfigMap key). The \\.
    // keeps jsonpath treating "reference-values.json" as one literal key.
    `oc create -f /tmp/out/rvps-reference-values.yaml --dry-run=client -o 'jsonpath={.data.reference-values\\.json}' > /tmp/rv.json`,
    // Merge helper: combines veritas's fresh values with whatever the ConfigMap
    // already holds (canonical map + legacy array, canonical winning collisions,
    // veritas winning same-name entries) and emits a JSON Patch guarded by a
    // resourceVersion test. Refuses to touch data it can't parse.
    `cat > /tmp/merge-rv.py <<'PYEOF'`,
    MERGE_PY,
    'PYEOF',
    // Re-read + re-merge + re-patch a few times: the resourceVersion test rejects
    // the patch when the ConfigMap changed concurrently (last-write-wins would
    // silently drop the losing side's values).
    'for attempt in 1 2 3; do',
    `  oc get configmap ${rvpsConfigMap} -n ${namespace} -o json > /tmp/rv-cm.json`,
    '  python3 /tmp/merge-rv.py /tmp/rv.json /tmp/rv-cm.json > /tmp/rv-patch.json',
    `  if oc patch configmap ${rvpsConfigMap} -n ${namespace} --type json -p "$(cat /tmp/rv-patch.json)"; then`,
    '    break',
    '  fi',
    '  if [ "$attempt" = 3 ]; then',
    '    echo "ERROR: the reference-values ConfigMap kept changing concurrently; giving up" >&2',
    '    exit 1',
    '  fi',
    '  echo "ConfigMap changed concurrently, retrying ($attempt/3)"',
    'done',
    `echo "PATCHED ${rvpsConfigMap}"`,
  ].join('\n');
};

// Kept as a constant so it reads as data, not control flow. Quoting rules: the
// heredoc is quoted ('PYEOF') so bash performs no expansion inside it.
const MERGE_PY = [
  'import base64, json, sys',
  '',
  'def fail(msg):',
  '    sys.exit("ERROR: " + msg)',
  '',
  'def enc(rv):',
  '    return base64.urlsafe_b64encode(json.dumps(rv, separators=(",", ":")).encode()).decode()',
  '',
  'def dec(v):',
  '    # tolerate both alphabets: the operator migration writes standard base64',
  '    return base64.b64decode(v.translate(str.maketrans("-_", "+/")))',
  '',
  'veritas_raw = json.load(open(sys.argv[1]))',
  'cm = json.load(open(sys.argv[2]))',
  'data = cm.get("data") or {}',
  '',
  '# existing canonical map first (values kept verbatim), then legacy-array entries',
  '# the canonical map lacks (canonical wins collisions)',
  'merged = {}',
  'legacy = None',
  'cur = (data.get("reference_value") or "").strip()',
  'if cur:',
  '    try:',
  '        parsed = json.loads(cur)',
  '    except ValueError:',
  '        fail("reference_value holds unparseable data; refusing to overwrite it")',
  '    if not isinstance(parsed, dict):',
  '        fail("reference_value is not a map; refusing to overwrite it")',
  '    for k, v in parsed.items():',
  '        if not isinstance(v, str):',
  '            fail("reference_value has a non-string entry; refusing to overwrite it")',
  '        merged[k] = v',
  'old = (data.get("reference-values.json") or "").strip()',
  'if old:',
  '    try:',
  '        legacy = json.loads(old)',
  '    except ValueError:',
  '        fail("reference-values.json holds unparseable data; refusing to overwrite it")',
  '    if not isinstance(legacy, list):',
  '        fail("reference-values.json is not an array; refusing to overwrite it")',
  '    for rv in legacy:',
  '        if isinstance(rv, dict) and rv.get("name") and rv["name"] not in merged:',
  '            merged[rv["name"]] = enc(rv)',
  '',
  '# veritas artifact: v1.1 emits an array; tolerate an already-converted map',
  'if isinstance(veritas_raw, list):',
  '    fresh = {rv["name"]: enc(rv) for rv in veritas_raw if isinstance(rv, dict) and rv.get("name")}',
  'elif isinstance(veritas_raw, dict):',
  '    fresh = veritas_raw',
  'else:',
  '    fail("unexpected veritas payload")',
  '',
  '# veritas entries win same-name collisions (regenerating refreshes them); every',
  '# other existing entry is preserved',
  'merged.update(fresh)',
  '',
  'patch = [{"op": "add", "path": "/data/reference_value", "value": json.dumps(merged, indent=2)}]',
  'if legacy is not None:',
  '    arr = []',
  '    for v in merged.values():',
  '        try:',
  '            arr.append(json.loads(dec(v)))',
  '        except Exception:',
  '            pass  # undecodable values cannot be represented in the legacy array',
  '    patch.append({"op": "add", "path": "/data/reference-values.json", "value": json.dumps(arr, indent=2)})',
  'rv = (cm.get("metadata") or {}).get("resourceVersion")',
  'if rv:',
  '    patch.insert(0, {"op": "test", "path": "/metadata/resourceVersion", "value": rv})',
  'print(json.dumps(patch))',
].join('\n');
