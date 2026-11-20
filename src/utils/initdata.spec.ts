/**
 * @jest-environment node
 *
 * This spec exercises the measurement digests, which need a stable WebCrypto. jsdom
 * ships no crypto.subtle (and shadows a polyfill across awaits), so run it under Node's
 * environment, where globalThis.crypto is the real WebCrypto. These are pure functions —
 * no DOM needed.
 */
import {
  buildInitdata,
  buildInitdataToml,
  buildWorkloadPodYaml,
  computeInitDataMrConfigId,
  computeMeasurement,
  computePcr8,
  SENSITIVE_REQUESTS,
  type InitdataInput,
} from './initdata';

const base: InitdataInput = {
  trusteeUrl: 'https://kbs.example.com',
  platform: 'tdx-baremetal',
  policyOverrides: {},
};

const sha256Hex = async (s: string): Promise<string> => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

// Slice the rendered document into its embedded sub-configs so assertions can target
// aa.toml vs cdh.toml independently.
const section = (toml: string, start: string, end?: string): string => {
  const from = toml.indexOf(start);
  const to = end ? toml.indexOf(end, from + start.length) : toml.length;
  return toml.slice(from, to === -1 ? toml.length : to);
};

describe('buildInitdataToml', () => {
  it('always uses the sha256 algorithm header', () => {
    expect(buildInitdataToml(base)).toContain('algorithm = "sha256"');
  });

  it('omits the cert from every embedded config when none is supplied (plain HTTP)', () => {
    const toml = buildInitdataToml({ ...base, trusteeUrl: 'http://kbs.example.com:8080' });
    expect(toml).not.toContain('kbs_cert');
    expect(toml).not.toContain('cert = """');
  });

  it('pins the cert in aa.toml (both token_configs) AND cdh.toml — the AA needs it too', () => {
    // Regression guard: the Attestation Agent does the /attest handshake, so the cert
    // must be in aa.toml's token_configs, not only cdh.toml's [kbc]. Omitting it there
    // caused "AA-KBC get token failed" against an HTTPS KBS.
    const toml = buildInitdataToml({ ...base, kbsCert: 'PEMBODY' });

    const aa = section(toml, '"aa.toml"', '"cdh.toml"');
    const cocoAs = section(aa, '[token_configs.coco_as]', '[token_configs.kbs]');
    const kbs = section(aa, '[token_configs.kbs]');
    const cdh = section(toml, '"cdh.toml"', '"policy.rego"');

    expect(cocoAs).toContain('cert = """');
    expect(kbs).toContain('cert = """');
    expect(cdh).toContain('kbs_cert = """');

    // The PEM body is wrapped into all three cert blocks.
    expect(toml.match(/PEMBODY/g) ?? []).toHaveLength(3);
  });

  it('accepts a full PEM and re-wraps it exactly once per cert block', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nABCDEF\n-----END CERTIFICATE-----';
    const toml = buildInitdataToml({ ...base, kbsCert: pem });
    // 3 blocks: aa coco_as, aa kbs, cdh kbc — each with a single BEGIN/END pair.
    expect(toml.match(/-----BEGIN CERTIFICATE-----/g) ?? []).toHaveLength(3);
    expect(toml.match(/-----END CERTIFICATE-----/g) ?? []).toHaveLength(3);
  });

  it('keeps the [image] policy inside cdh.toml only (not aa.toml)', () => {
    const toml = buildInitdataToml({
      ...base,
      imageSecurityPolicyUri: 'kbs:///default/security-policy/test',
    });
    const aa = section(toml, '"aa.toml"', '"cdh.toml"');
    const cdh = section(toml, '"cdh.toml"', '"policy.rego"');
    expect(aa).not.toContain('[image]');
    expect(cdh).toContain('[image]');
  });
});

describe('initdata measurement', () => {
  const toml = 'algorithm = "sha256"\n[data]\n';

  it('bare-metal TDX = raw sha256 right-padded to the 48-byte MRCONFIGID', async () => {
    const m = await computeInitDataMrConfigId(toml);
    expect(m).toHaveLength(96); // 48 bytes
    // First 32 bytes are the sha256 of the toml; the rest is zero padding.
    expect(m.slice(0, 64)).toBe(await sha256Hex(toml));
    expect(m.slice(64)).toBe('0'.repeat(32));
  });

  it('cloud = a TPM PCR-8 extend: sha256(32 zero bytes ‖ sha256(toml)), 32 bytes', async () => {
    const pcr8 = await computePcr8(toml);
    expect(pcr8).toHaveLength(64); // 32 bytes
    // It is NOT the raw digest nor the padded MRCONFIGID.
    expect(pcr8).not.toBe(await sha256Hex(toml));
    expect(pcr8).not.toBe(await computeInitDataMrConfigId(toml));
  });

  it('is deterministic', async () => {
    expect(await computePcr8(toml)).toBe(await computePcr8(toml));
    expect(await computeInitDataMrConfigId(toml)).toBe(await computeInitDataMrConfigId(toml));
  });

  it('computeMeasurement routes bare-metal to MRCONFIGID and cloud to PCR 8', async () => {
    expect(await computeMeasurement('tdx-baremetal', toml)).toBe(
      await computeInitDataMrConfigId(toml),
    );
    expect(await computeMeasurement('snp-cloud', toml)).toBe(await computePcr8(toml));
    expect(await computeMeasurement('tdx-cloud', toml)).toBe(await computePcr8(toml));
  });
});

describe('buildWorkloadPodYaml', () => {
  it('embeds the annotation and a kata-cc scaffold for bare metal', () => {
    const y = buildWorkloadPodYaml({
      annotation: 'H4sIabc',
      source: 'tc',
      kbsUrl: 'http://kbs',
      measurement: 'deadbeef',
      platform: 'tdx-baremetal',
    });
    expect(y).toContain('io.katacontainers.config.hypervisor.cc_init_data: "H4sIabc"');
    expect(y).toContain('runtimeClassName: kata-cc');
    expect(y).toContain('# KBS endpoint: http://kbs');
    expect(y).toContain('deadbeef'); // measurement carried in the header
    expect(y).toContain('authored by Trustee (tc)');
  });

  it('uses the kata-remote runtime class for cloud peer pods', () => {
    const y = buildWorkloadPodYaml({ annotation: 'X', platform: 'snp-cloud' });
    expect(y).toContain('runtimeClassName: kata-remote');
  });

  it('defaults to a bare-metal kata-cc scaffold when only the annotation is given', () => {
    const y = buildWorkloadPodYaml({ annotation: 'X' });
    expect(y).toContain('cc_init_data: "X"');
    expect(y).not.toContain('# KBS endpoint:');
    expect(y).toContain('runtimeClassName: kata-cc');
    expect(y).toContain('name: my-confidential-workload');
  });

  it('carries a simple, clearly editable container example and apply instructions', () => {
    const y = buildWorkloadPodYaml({ annotation: 'X' });
    // A runnable example container (not a bare placeholder), marked as
    // replaceable, plus explicit replace/apply guidance.
    expect(y).toContain('image: quay.io/kata-containers/alpine-bash-curl:latest');
    expect(y).toContain(
      "command: ['sh', '-c', 'echo confidential workload started; sleep infinity']",
    );
    expect(y).toContain('Replace the pod name,');
    expect(y).toContain('image, and command with your workload');
    expect(y).toContain('oc apply -f <this-file>.yaml');
    // The annotation and runtime class are the parts that must NOT be edited.
    expect(y).toContain('keep the annotation and');
  });

  it('embeds the exact generated annotation and measurement from buildInitdata', async () => {
    // The downloaded/previewed Pod must carry byte-for-byte the annotation the
    // initdata builder produced (and whose measurement got registered) — a
    // regenerated or truncated annotation would fail attestation.
    const result = await buildInitdata(base);
    const y = buildWorkloadPodYaml({
      annotation: result.annotation,
      measurement: result.measurement,
      platform: result.platform,
    });
    expect(y).toContain(`io.katacontainers.config.hypervisor.cc_init_data: "${result.annotation}"`);
    expect(y).toContain(`#   ${result.measurement}`);
    // And the annotation really is the gzip+base64 of the generated initdata.
    const { gunzipSync } = await import('node:zlib');
    expect(gunzipSync(Buffer.from(result.annotation, 'base64')).toString()).toBe(result.toml);
  });
});

describe('Kata Agent debugging permissions', () => {
  // Pull the rendered `default <Request> := <bool>` out of the policy.rego the
  // initdata carries, so assertions target the generated permission directly.
  const renderedPermission = (toml: string, req: string): boolean | undefined => {
    const m = new RegExp(`default ${req} := (true|false)`).exec(toml);
    return m ? m[1] === 'true' : undefined;
  };

  it('surfaces exactly the three independent debugging toggles', () => {
    expect([...SENSITIVE_REQUESTS]).toEqual([
      'ExecProcessRequest',
      'ReadStreamRequest',
      'WriteStreamRequest',
    ]);
  });

  it('production defaults (no overrides) leave all three disabled', () => {
    const toml = buildInitdataToml({ ...base, policyOverrides: {} });
    for (const req of SENSITIVE_REQUESTS) {
      expect(renderedPermission(toml, req)).toBe(false);
    }
  });

  it('enabling exec + read for debugging renders exactly those, WriteStream stays off', () => {
    // ReadStreamRequest — not WriteStreamRequest — is what makes exec output
    // (e.g. a fetched secret) visible.
    const toml = buildInitdataToml({
      ...base,
      policyOverrides: { ExecProcessRequest: true, ReadStreamRequest: true },
    });
    expect(renderedPermission(toml, 'ExecProcessRequest')).toBe(true);
    expect(renderedPermission(toml, 'ReadStreamRequest')).toBe(true);
    expect(renderedPermission(toml, 'WriteStreamRequest')).toBe(false);
  });

  it('read and write stream permissions are independent of each other', () => {
    const readOnly = buildInitdataToml({ ...base, policyOverrides: { ReadStreamRequest: true } });
    expect(renderedPermission(readOnly, 'ReadStreamRequest')).toBe(true);
    expect(renderedPermission(readOnly, 'WriteStreamRequest')).toBe(false);

    const writeOnly = buildInitdataToml({ ...base, policyOverrides: { WriteStreamRequest: true } });
    expect(renderedPermission(writeOnly, 'WriteStreamRequest')).toBe(true);
    expect(renderedPermission(writeOnly, 'ReadStreamRequest')).toBe(false);
  });

  it('enabling exec does NOT silently enable any stream permission', () => {
    const toml = buildInitdataToml({ ...base, policyOverrides: { ExecProcessRequest: true } });
    expect(renderedPermission(toml, 'ExecProcessRequest')).toBe(true);
    expect(renderedPermission(toml, 'ReadStreamRequest')).toBe(false);
    expect(renderedPermission(toml, 'WriteStreamRequest')).toBe(false);
  });

  it('disabling debugging again restores the restrictive defaults', () => {
    const toml = buildInitdataToml({
      ...base,
      policyOverrides: {
        ExecProcessRequest: false,
        ReadStreamRequest: false,
        WriteStreamRequest: false,
      },
    });
    for (const req of SENSITIVE_REQUESTS) {
      expect(renderedPermission(toml, req)).toBe(false);
    }
  });
});
