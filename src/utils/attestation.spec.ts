import {
  verdictLabel,
  buildChecks,
  remediation,
  type AttestWorkload,
  type AttestContext,
  type TFn,
  type ProbeEvent,
} from './attestation';

const t: TFn = (key, opts) => {
  if (!opts) return key;
  return Object.entries(opts).reduce<string>((s, [k, v]) => s.replace(`{{${k}}}`, String(v)), key);
};

const baseWorkload: AttestWorkload = {
  uid: 'uid-1',
  name: 'pod-1',
  namespace: 'ns',
  nodeName: 'node-1',
  runtime: 'kata-cc',
  gpu: false,
  hasInitData: true,
  phase: 'Running',
  ready: true,
  tee: 'tdx',
  onTeeNode: true,
  nodeKnown: true,
  peerPod: false,
};

const healthyCtx: AttestContext = { kbsReady: true, referenceValuesPresent: true };

describe('verdictLabel', () => {
  it('returns translated verdict labels', () => {
    expect(verdictLabel('healthy', t)).toBe('Healthy');
    expect(verdictLabel('failing', t)).toBe('Failing');
    expect(verdictLabel('no-attestation', t)).toBe('Not attesting');
    expect(verdictLabel('pending', t)).toBe('Pending');
    expect(verdictLabel('unknown', t)).toBe('Unknown');
  });
});

describe('buildChecks', () => {
  it('returns 5 checks for a healthy workload', () => {
    const checks = buildChecks(baseWorkload, healthyCtx, t);
    expect(checks).toHaveLength(5);
    expect(checks.every((c) => c.state === 'ok')).toBe(true);
  });

  it('marks initdata as fail when missing', () => {
    const w = { ...baseWorkload, hasInitData: false };
    const checks = buildChecks(w, healthyCtx, t);
    const initdata = checks.find((c) => c.id === 'initdata');
    expect(initdata?.state).toBe('fail');
  });

  it('marks KBS as fail when not ready', () => {
    const ctx = { ...healthyCtx, kbsReady: false };
    const checks = buildChecks(baseWorkload, ctx, t);
    const kbs = checks.find((c) => c.id === 'kbs');
    expect(kbs?.state).toBe('fail');
  });

  it('marks reference values as warn when absent', () => {
    const ctx = { ...healthyCtx, referenceValuesPresent: false };
    const checks = buildChecks(baseWorkload, ctx, t);
    const rv = checks.find((c) => c.id === 'refvals');
    expect(rv?.state).toBe('warn');
  });

  it('interpolates node name in TEE detail', () => {
    const checks = buildChecks(baseWorkload, healthyCtx, t);
    const tee = checks.find((c) => c.id === 'tee');
    expect(tee?.detail).toContain('node-1');
  });
});

describe('remediation', () => {
  it('suggests initdata when missing', () => {
    const w = { ...baseWorkload, hasInitData: false };
    const rems = remediation(w, healthyCtx, false, undefined, undefined, t);
    expect(rems.some((r) => r.text.includes('initdata'))).toBe(true);
  });

  it('suggests TEE node when pod is on wrong node', () => {
    const w = { ...baseWorkload, onTeeNode: false };
    const rems = remediation(w, healthyCtx, false, undefined, undefined, t);
    expect(rems.some((r) => r.text.includes('hardware TEE'))).toBe(true);
  });

  it('suggests checking KBS health when not ready', () => {
    const ctx = { ...healthyCtx, kbsReady: false };
    const rems = remediation(baseWorkload, ctx, false, undefined, undefined, t);
    expect(rems.some((r) => r.text.includes('KBS is not ready'))).toBe(true);
  });

  it('suggests registering reference values when absent', () => {
    const ctx = { ...healthyCtx, referenceValuesPresent: false };
    const rems = remediation(baseWorkload, ctx, false, undefined, undefined, t);
    expect(rems.some((r) => r.text.includes('no reference values'))).toBe(true);
  });

  it('always includes the CDH probe command', () => {
    const rems = remediation(baseWorkload, healthyCtx, false, undefined, undefined, t);
    expect(rems.some((r) => r.cdhCommand)).toBe(true);
  });

  it('detects cert-expiry events', () => {
    const events: ProbeEvent[] = [
      {
        reason: 'Failed',
        message: 'tls certificate expired',
        type: 'Warning',
        count: 1,
        attestationRelated: true,
      },
    ];
    const rems = remediation(baseWorkload, healthyCtx, true, undefined, events, t);
    expect(rems.some((r) => r.text.includes('TLS or certificate error'))).toBe(true);
  });

  it('detects KBS-unreachable events', () => {
    const events: ProbeEvent[] = [
      {
        reason: 'Failed',
        message: 'connection refused to kbs',
        type: 'Warning',
        count: 1,
        attestationRelated: true,
      },
    ];
    const rems = remediation(baseWorkload, healthyCtx, true, undefined, events, t);
    expect(rems.some((r) => r.text.includes('cannot reach the KBS'))).toBe(true);
  });

  it('does not add cert/network hints without matching events', () => {
    const rems = remediation(baseWorkload, healthyCtx, false, undefined, [], t);
    expect(rems.some((r) => r.text.includes('TLS or certificate'))).toBe(false);
    expect(rems.some((r) => r.text.includes('cannot reach'))).toBe(false);
  });
});
