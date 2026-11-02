import { buildReadiness, findKbsRoute, type ReadinessCheck } from './readiness';
import {
  KBS_SERVICE_NAME,
  RVPS_REFERENCE_VALUES_KEY,
  RVPS_REFERENCE_VALUES_LEGACY_KEY,
} from '../k8s/resources';
import { encodeReferenceValue } from './referenceValues';
import type { ConfigMapKind, RouteKind, TrusteeConfigKind } from '../k8s/types';

const labels = {
  tcReconciled: 'reconciled',
  tcReconciling: 'reconciling',
  tcConditionPrefix: 'not ready: ',
  routeAdmitted: (host: string) => `admitted:${host}`,
  routePending: 'route-pending',
  routeMissing: 'route-missing',
  refvalsPresent: 'refvals-present',
  refvalsMissing: 'refvals-missing',
};

const kbsRoute = (host: string | undefined, admittedHost?: string): RouteKind => ({
  metadata: { name: 'kbs' },
  spec: { host, to: { name: KBS_SERVICE_NAME } },
  status: admittedHost ? { ingress: [{ host: admittedHost }] } : { ingress: [] },
});

const rvCm = (json: string, key: string = RVPS_REFERENCE_VALUES_KEY): ConfigMapKind => ({
  metadata: { name: 'tc-rvps-reference-values' },
  data: { [key]: json },
});

const check = (checks: ReadinessCheck[], id: ReadinessCheck['id']): ReadinessCheck => {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
};

describe('findKbsRoute', () => {
  it('finds the Route targeting the KBS Service', () => {
    const other: RouteKind = { spec: { to: { name: 'something-else' } } };
    const route = kbsRoute('kbs.apps.example.com', 'kbs.apps.example.com');
    expect(findKbsRoute([other, route])).toBe(route);
  });

  it('returns undefined when no Route targets the KBS', () => {
    expect(findKbsRoute([{ spec: { to: { name: 'x' } } }])).toBeUndefined();
  });
});

describe('buildReadiness', () => {
  const readyTc: TrusteeConfigKind = { status: { isReady: true } };

  it('marks TrusteeConfig pending and reconciling when not ready', () => {
    const checks = buildReadiness({ tc: {}, routes: [], rvpsCm: undefined }, labels);
    expect(check(checks, 'trusteeconfig')).toMatchObject({
      state: 'pending',
      detail: 'reconciling',
    });
  });

  it('surfaces a stuck TrusteeConfig condition message', () => {
    const tc: TrusteeConfigKind = {
      status: {
        conditions: [{ type: 'Ready', status: 'False', reason: 'KbsError', message: 'no secret' }],
      },
    };
    const checks = buildReadiness({ tc, routes: [], rvpsCm: undefined }, labels);
    expect(check(checks, 'trusteeconfig')).toMatchObject({
      state: 'pending',
      detail: 'not ready: KbsError: no secret',
    });
  });

  it('marks TrusteeConfig ok when reconciled', () => {
    const checks = buildReadiness({ tc: readyTc, routes: [], rvpsCm: undefined }, labels);
    expect(check(checks, 'trusteeconfig')).toMatchObject({ state: 'ok', detail: 'reconciled' });
  });

  it('warns (not fails) when the KBS Route is missing — co-located is valid', () => {
    const checks = buildReadiness({ tc: readyTc, routes: [], rvpsCm: undefined }, labels);
    expect(check(checks, 'route')).toMatchObject({ state: 'warn', detail: 'route-missing' });
  });

  it('marks the Route pending until it is admitted', () => {
    const checks = buildReadiness(
      { tc: readyTc, routes: [kbsRoute('kbs.apps.example.com')], rvpsCm: undefined },
      labels,
    );
    expect(check(checks, 'route')).toMatchObject({ state: 'warn', detail: 'route-pending' });
  });

  it('marks the Route ok with the admitted host', () => {
    const checks = buildReadiness(
      {
        tc: readyTc,
        routes: [kbsRoute('kbs.apps.example.com', 'kbs.apps.example.com')],
        rvpsCm: undefined,
      },
      labels,
    );
    expect(check(checks, 'route')).toMatchObject({
      state: 'ok',
      detail: 'admitted:kbs.apps.example.com',
    });
  });

  it('warns when reference values are empty and ok when present', () => {
    const empty = buildReadiness({ tc: readyTc, routes: [], rvpsCm: rvCm('{}') }, labels);
    expect(check(empty, 'refvals').state).toBe('warn');

    // Operator ≥ v1.2 format: reference_value map of base64-encoded entries.
    const present = buildReadiness(
      {
        tc: readyTc,
        routes: [],
        rvpsCm: rvCm(
          JSON.stringify({
            init_data: encodeReferenceValue({
              name: 'init_data',
              expiration: '2099-12-31T00:00:00Z',
              value: ['abc'],
            }),
          }),
        ),
      },
      labels,
    );
    expect(check(present, 'refvals')).toMatchObject({ state: 'ok', detail: 'refvals-present' });
  });

  it('accepts the legacy reference-values.json key (operator ≤ v1.1 skew)', () => {
    const present = buildReadiness(
      {
        tc: readyTc,
        routes: [],
        rvpsCm: rvCm(JSON.stringify([{ name: 'init_data' }]), RVPS_REFERENCE_VALUES_LEGACY_KEY),
      },
      labels,
    );
    expect(check(present, 'refvals').state).toBe('ok');

    const empty = buildReadiness(
      { tc: readyTc, routes: [], rvpsCm: rvCm('[]', RVPS_REFERENCE_VALUES_LEGACY_KEY) },
      labels,
    );
    expect(check(empty, 'refvals').state).toBe('warn');
  });
});
