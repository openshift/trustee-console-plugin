import {
  buildAttestationTokenSecretScript,
  buildHttpsTlsSecretScript,
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
