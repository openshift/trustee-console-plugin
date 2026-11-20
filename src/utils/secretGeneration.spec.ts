import {
  buildAttestationTokenSecretScript,
  buildHttpsTlsSecretScript,
  buildSanList,
  isValidSecretName,
  type SecretScriptOptions,
} from './secretGeneration';

const opts: SecretScriptOptions = {
  secret: 'trustee-token-cert',
  cn: 'kbs-service',
  san: 'DNS:kbs-service',
  namespace: 'trustee-operator-system',
};

describe('buildAttestationTokenSecretScript', () => {
  it('mints a self-signed ECDSA P-256 key/cert in PKCS8', () => {
    const script = buildAttestationTokenSecretScript(opts);

    expect(script).toContain('openssl ecparam -name prime256v1');
    expect(script).toContain('openssl pkcs8 -topk8 -nocrypt');
    expect(script).toContain('-x509');
    // A self-signed end-entity cert, not a CA.
    expect(script).toContain('basicConstraints=critical,CA:FALSE');
  });

  it('applies a kubernetes.io/tls Secret with tls.crt and tls.key', () => {
    const script = buildAttestationTokenSecretScript(opts);

    expect(script).toContain('"type":"kubernetes.io/tls"');
    expect(script).toContain('"tls.crt":"%s","tls.key":"%s"');
    expect(script).toContain('"$B64CRT" "$B64KEY"');
    // No ca.crt in the Secret data — the token cert is self-signed and the
    // operator only reads tls.*. (KUBECA is the API server's own CA path.)
    expect(script).not.toContain('"ca.crt":"%s"');
  });

  it('targets the given namespace, secret name and field manager', () => {
    const script = buildAttestationTokenSecretScript(opts);

    expect(script).toContain(
      '/api/v1/namespaces/trustee-operator-system/secrets/trustee-token-cert',
    );
    expect(script).toContain('fieldManager=trustee-token-gen');
    expect(script).toContain('CREATED trustee-token-cert');
  });

  it('escapes shell-significant characters in the certificate name', () => {
    const script = buildAttestationTokenSecretScript({ ...opts, cn: 'kbs"x' });

    expect(script).not.toContain('"/CN=kbs"x"');
    expect(script).toContain('"/CN=kbs\\"x"');
  });
});

describe('buildHttpsTlsSecretScript', () => {
  it('mints a CA and an end-entity server leaf it signs', () => {
    const script = buildHttpsTlsSecretScript(opts);

    expect(script).toContain('basicConstraints=critical,CA:TRUE');
    expect(script).toContain('basicConstraints=critical,CA:FALSE');
    expect(script).toContain('openssl x509 -req -in tls.csr -CA ca.crt -CAkey ca.key');
  });

  it('stores tls.crt, tls.key and the ca.crt trust anchor', () => {
    const script = buildHttpsTlsSecretScript(opts);

    expect(script).toContain('"tls.crt":"%s","tls.key":"%s","ca.crt":"%s"');
    expect(script).toContain('"$B64CRT" "$B64KEY" "$B64CA"');
    expect(script).toContain('fieldManager=trustee-tls-gen');
  });

  it('bakes the short Service name, its cluster-local FQDN and the ingress wildcard into the leaf', () => {
    const cn = 'kbs-service.trustee-operator-system.svc';
    const script = buildHttpsTlsSecretScript({
      ...opts,
      cn,
      san: buildSanList(cn, 'apps.example.com').join(','),
    });

    expect(script).toContain(
      'subjectAltName=DNS:kbs-service.trustee-operator-system.svc,DNS:kbs-service.trustee-operator-system.svc.cluster.local,DNS:*.apps.example.com',
    );
  });
});

describe('buildSanList', () => {
  it('covers the short Service name, its cluster-local FQDN and the ingress wildcard by default', () => {
    expect(buildSanList('kbs-service.trustee-operator-system.svc', 'apps.example.com')).toEqual([
      'DNS:kbs-service.trustee-operator-system.svc',
      'DNS:kbs-service.trustee-operator-system.svc.cluster.local',
      'DNS:*.apps.example.com',
    ]);
  });

  it('does not duplicate the FQDN when the CN already is the FQDN', () => {
    expect(
      buildSanList('kbs-service.trustee-operator-system.svc.cluster.local', 'apps.example.com'),
    ).toEqual([
      'DNS:kbs-service.trustee-operator-system.svc.cluster.local',
      'DNS:*.apps.example.com',
    ]);
  });

  it('passes custom hostnames (e.g. Route names) through unchanged', () => {
    expect(buildSanList('kbs.trustee.apps.example.com', 'apps.example.com')).toEqual([
      'DNS:kbs.trustee.apps.example.com',
      'DNS:*.apps.example.com',
    ]);
  });

  it('keeps attestation-token CNs unchanged (the hostname is never contacted)', () => {
    expect(buildSanList('trustee-config-token', 'apps.example.com')).toEqual([
      'DNS:trustee-config-token',
      'DNS:*.apps.example.com',
    ]);
  });

  it('omits the ingress wildcard when no ingress domain is known', () => {
    expect(buildSanList('kbs-service.trustee-operator-system.svc')).toEqual([
      'DNS:kbs-service.trustee-operator-system.svc',
      'DNS:kbs-service.trustee-operator-system.svc.cluster.local',
    ]);
  });

  it('trims whitespace from the CN', () => {
    expect(buildSanList('  kbs-service.trustee-operator-system.svc  ')).toEqual([
      'DNS:kbs-service.trustee-operator-system.svc',
      'DNS:kbs-service.trustee-operator-system.svc.cluster.local',
    ]);
  });
});

describe('isValidSecretName', () => {
  it('accepts lowercase DNS labels', () => {
    expect(isValidSecretName('trustee-token-cert')).toBe(true);
    expect(isValidSecretName('kbs123')).toBe(true);
  });

  it('rejects empty, uppercase, dotted or over-long names', () => {
    expect(isValidSecretName('')).toBe(false);
    expect(isValidSecretName('Trustee')).toBe(false);
    expect(isValidSecretName('-leading')).toBe(false);
    expect(isValidSecretName('trailing-')).toBe(false);
    expect(isValidSecretName('a'.repeat(254))).toBe(false);
  });
});
