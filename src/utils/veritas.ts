// ---------------------------------------------------------------------------
// veritas reference-value generation script.
//
// veritas renders its results as a ConfigMap manifest of its own: name chosen
// by the tool (`rvps-reference-values` in the released coco-tools <= 1.12,
// `trusteeconfig-rvps-reference-values` on upstream main) — neither matches the
// ConfigMap the Trustee operator actually mounts. The released tool writes a
// plain JSON array of reference values (the v1.1 wire format) under the data
// key `reference-values.json`; upstream main instead writes the operator's
// `reference_value` key holding the RVPS local_json map (name → base64 compact
// JSON). The Trustee operator (v1.2.0+) mounts `<tc>-rvps-reference-values`'s
// `reference_value` key (see src/utils/referenceValues.ts).
//
// The script below therefore never applies veritas's manifest. It renders it
// client-side, hands the whole manifest to a merge helper that accepts EITHER
// data key and EITHER payload shape (array → converted to the map format; map
// → kept verbatim), and MERGES the result into the operator's ConfigMap under
// `reference_value` — existing entries under other names (e.g. a manually
// registered init_data value) are preserved; only same-name entries are
// refreshed (that's the point of regenerating after an upgrade). A present
// legacy `reference-values.json` key is kept in sync, mirroring
// registerReferenceValue on the plugin side.
//
// The patch is a JSON Patch guarded by a `test` on the ConfigMap's
// resourceVersion, so a concurrent write fails loudly instead of silently
// losing one side; the loop re-reads and re-merges a few times before giving up.
// ---------------------------------------------------------------------------

/** File locations the merge steps use — differs between the Job and a laptop. */
interface MergePaths {
  /** veritas's rendered manifest (rvps-reference-values.yaml). */
  veritasYaml: string;
  /** That manifest rendered to JSON by a client-side dry run. */
  verbatimJson: string;
  /** Where the merge helper python script is written. */
  mergePy: string;
  /** The live operator-managed ConfigMap, as JSON. */
  cmJson: string;
  /** The JSON Patch the helper emits. */
  patchJson: string;
}

/**
 * The oc + python steps that merge veritas's rendered manifest into the
 * operator-managed `rvpsConfigMap` ConfigMap. Shared verbatim between the
 * in-cluster Job script and the manual commands so the two flows cannot drift.
 */
const mergeSteps = (paths: MergePaths, rvpsConfigMap: string, namespace: string): string[] => [
  // Render veritas's manifest client-side as JSON. Do NOT `oc apply` it:
  // veritas names the ConfigMap itself (never this TrusteeConfig's
  // operator-managed one), and the released tool writes the v1.1 array under
  // `reference-values.json` rather than the operator's `reference_value` map.
  `oc create -f ${paths.veritasYaml} --dry-run=client -o json > ${paths.verbatimJson}`,
  // Merge helper: accepts either veritas data key/payload shape, combines the
  // fresh values with whatever the ConfigMap already holds (canonical map +
  // legacy array, canonical winning collisions, veritas winning same-name
  // entries) and emits a JSON Patch guarded by a resourceVersion test.
  // Refuses to touch data it can't parse.
  `cat > ${paths.mergePy} <<'PYEOF'`,
  MERGE_PY,
  'PYEOF',
  // Re-read + re-merge + re-patch a few times: the resourceVersion test rejects
  // the patch when the ConfigMap changed concurrently (last-write-wins would
  // silently drop the losing side's values).
  'for attempt in 1 2 3; do',
  `  oc get configmap ${rvpsConfigMap} -n ${namespace} -o json > ${paths.cmJson}`,
  `  python3 ${paths.mergePy} ${paths.verbatimJson} ${paths.cmJson} > ${paths.patchJson}`,
  `  if oc patch configmap ${rvpsConfigMap} -n ${namespace} --type json -p "$(cat ${paths.patchJson})"; then`,
  '    break',
  '  fi',
  '  if [ "$attempt" = 3 ]; then',
  '    echo "ERROR: the reference-values ConfigMap kept changing concurrently; giving up" >&2',
  '    exit 1',
  '  fi',
  '  echo "ConfigMap changed concurrently, retrying ($attempt/3)"',
  'done',
  `echo "PATCHED ${rvpsConfigMap}"`,
];

/** Flags every veritas invocation shares (in-cluster Job and manual run). */
const veritasFlags = (opts: {
  tee: 'tdx' | 'snp';
  ocpVersion: string;
  gpu: boolean;
  xfamFeatures: string[];
  initdataPath?: string;
  authfilePath: string;
  outputDir: string;
}): string =>
  [
    'veritas --platform baremetal',
    `--tee ${opts.tee}`,
    `--ocp-version ${opts.ocpVersion}`,
    opts.initdataPath ? `--initdata ${opts.initdataPath}` : '',
    `--authfile ${opts.authfilePath}`,
    opts.gpu ? '--gpu' : '',
    opts.xfamFeatures.map((f) => `--hw-xfam-allow ${f}`).join(' '),
    `-o ${opts.outputDir}`,
  ]
    .filter((s) => s.length > 0)
    .join(' ');

/**
 * Fixed names of every resource the in-cluster generation flow creates, so the
 * create path and the cleanup path can never drift apart. The Job, its
 * ServiceAccount, Role and RoleBinding all share the bare prefix and are reused
 * across runs; the pull secret (a copy of the cluster pull secret) and the
 * initdata ConfigMap are per-run and must be deleted once the Job is terminal.
 */
export const generationResourceNames = (
  trusteeConfigName: string,
): {
  /** Job, ServiceAccount, Role and RoleBinding name (all the same). */
  prefix: string;
  /** Copy of the cluster pull secret the Job mounts — sensitive, delete after use. */
  pullSecret: string;
  /** ConfigMap holding the optional initdata.toml supplied to veritas. */
  initdataConfigMap: string;
} => {
  const prefix = `${trusteeConfigName}-rvps-gen`;
  return {
    prefix,
    pullSecret: `${prefix}-pull`,
    initdataConfigMap: `${prefix}-initdata`,
  };
};

/**
 * Build the bash `-c` script the veritas Job runs. It generates RVPS reference
 * values for the given TEE/OCP version, renders veritas's own ConfigMap
 * manifest client-side, converts/merges it into the operator-generated
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
  const veritasCmd = veritasFlags({
    tee,
    ocpVersion,
    gpu,
    xfamFeatures,
    initdataPath: hasInitdata ? '/initdata/initdata.toml' : undefined,
    authfilePath: '/auth/.dockerconfigjson',
    outputDir: '/tmp/out',
  });

  return [
    'set -e',
    'mkdir -p /tmp/out',
    veritasCmd,
    ...mergeSteps(
      {
        veritasYaml: '/tmp/out/rvps-reference-values.yaml',
        verbatimJson: '/tmp/rv-verbatim.json',
        mergePy: '/tmp/merge-rv.py',
        cmJson: '/tmp/rv-cm.json',
        patchJson: '/tmp/rv-patch.json',
      },
      rvpsConfigMap,
      namespace,
    ),
  ].join('\n');
};

/**
 * Manual / advanced commands for running the same generation outside the
 * cluster (podman + oc from a laptop). Mirrors the in-cluster Job — same
 * veritas flags, same merge helper — and merges into the operator-managed
 * ConfigMap instead of applying veritas's own manifest, whose ConfigMap name
 * and data key never match the operator's.
 */
export const buildManualVeritasCommands = (opts: {
  tee: 'tdx' | 'snp';
  ocpVersion?: string;
  xfamFeatures?: string[];
  rvpsConfigMap: string;
  namespace: string;
}): string => {
  const { tee, ocpVersion, xfamFeatures, rvpsConfigMap, namespace } = opts;
  const features = xfamFeatures ?? ['x87', 'sse', 'avx'];
  const version = ocpVersion ?? '<your-ocp-version>';
  const veritasCmd = [
    'podman run --rm \\',
    '  -v "$PWD/veritas-out:/tmp/out:Z" \\',
    '  -v "$HOME/.docker/config.json:/auth/.dockerconfigjson:Z" \\',
    '  quay.io/openshift_sandboxed_containers/coco-tools:1.12 \\',
    `  veritas --platform baremetal --tee ${tee} --ocp-version ${version} \\`,
    '    --authfile /auth/.dockerconfigjson \\',
    `${features.map((f) => `--hw-xfam-allow ${f}`).join(' ')} \\`,
    '    -o /tmp/out',
  ].join('\n');

  return [
    '# 1) Run veritas — same flags the in-cluster generator uses.',
    `#    Adjust the XFAM features to your hardware${ocpVersion ? '' : ', replace <your-ocp-version> with your OpenShift version'};`,
    '#    add --gpu for GPU pods, or --initdata /path/to/initdata.toml to fold an',
    '#    initdata measurement in (mount it into the container like the auth file).',
    'mkdir -p veritas-out',
    veritasCmd,
    '',
    '# 2) Merge the generated values into the operator-managed ConfigMap.',
    '#    Do NOT "oc apply" veritas\'s own manifest — it names the ConfigMap itself',
    "#    and never matches this TrusteeConfig's ConfigMap. The merge below keeps",
    '#    existing entries (e.g. an init_data measurement); only same-name entries',
    '#    are refreshed.',
    ...mergeSteps(
      {
        veritasYaml: 'veritas-out/rvps-reference-values.yaml',
        verbatimJson: 'rv-verbatim.json',
        mergePy: 'merge-rv.py',
        cmJson: 'rv-cm.json',
        patchJson: 'rv-patch.json',
      },
      rvpsConfigMap,
      namespace,
    ),
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
  "# argv[1] = veritas's rendered ConfigMap manifest (client-side dry-run JSON),",
  '# argv[2] = the live operator-managed ConfigMap.',
  'veritas_cm = json.load(open(sys.argv[1]))',
  'cm = json.load(open(sys.argv[2]))',
  'data = cm.get("data") or {}',
  '',
  '# veritas emits its values under either data key, depending on version:',
  '# released coco-tools <= 1.12 writes the v1.1 array under',
  '# "reference-values.json"; upstream main writes the operator\'s "reference_value"',
  '# map (name -> base64 compact JSON). Accept both keys and both shapes.',
  'vdata = veritas_cm.get("data") or {}',
  'raw = (vdata.get("reference_value") or vdata.get("reference-values.json") or "").strip()',
  'if not raw:',
  "    fail(\"veritas output has no values under 'reference_value' or 'reference-values.json'\")",
  'veritas_raw = json.loads(raw)',
  'if isinstance(veritas_raw, list):',
  '    fresh = {rv["name"]: enc(rv) for rv in veritas_raw if isinstance(rv, dict) and rv.get("name")}',
  'elif isinstance(veritas_raw, dict):',
  "    # already the operator's map format — keep the encoded values verbatim",
  '    for k, v in veritas_raw.items():',
  '        if not isinstance(v, str):',
  '            fail("veritas reference_value has a non-string entry for \'" + k + "\'")',
  '    fresh = veritas_raw',
  'else:',
  '    fail("unexpected veritas payload")',
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
