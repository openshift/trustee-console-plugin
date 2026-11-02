// ---------------------------------------------------------------------------
// Pure builders for the in-cluster OpenSSL Jobs that mint KBS TLS material.
//
// The private keys are generated inside the cluster (never in the browser) and
// server-side-applied as a kubernetes.io/tls Secret by the Job's own
// ServiceAccount. Two variants:
//
//  - HTTPS: a CA plus an end-entity server leaf it signs. KBS must serve a
//    separate CA->leaf chain — the in-guest Confidential Data Hub rejects a
//    single self-signed CA:TRUE certificate presented as the server leaf.
//  - Attestation token: a self-signed ECDSA P-256 certificate/key in PKCS8
//    (the algorithm/encoding the Trustee operator's token signing requires).
//    KBS signs the short-lived attestation token with this key and verifies it
//    with the certificate, so a pod cannot forge a token and bypass the
//    reference-value checks.
//
// Kept separate from the React modal so the shell contract is unit-tested.
// ---------------------------------------------------------------------------

/** A Kubernetes object name / DNS-1123 label (also used for the secret name). */
const DNS_1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export const isValidSecretName = (name: string): boolean =>
  name.length > 0 && name.length <= 253 && DNS_1123.test(name);

/** Escape a value interpolated into a double-quoted bash/openssl argument. */
const dq = (value: string): string => value.replace(/([\\"$`])/g, '\\$1');

export interface SecretScriptOptions {
  /** Name of the kubernetes.io/tls Secret to create. */
  secret: string;
  /** Certificate subject common name (also the primary SAN). */
  cn: string;
  /** Subject alternative names, already formatted as `DNS:a,DNS:b`. */
  san: string;
  /** Namespace the Secret is created in. */
  namespace: string;
}

/** The tail shared by both scripts: PATCH the Secret as the Job's SA. */
const applyTlsSecret = (opts: {
  secret: string;
  namespace: string;
  /** printf conversions and the matching shell variables (e.g. "$B64CRT"). */
  dataFormat: string;
  dataArgs: string[];
  fieldManager: string;
}): string[] => {
  const { secret, namespace, dataFormat, dataArgs, fieldManager } = opts;
  return [
    'TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)',
    'KUBECA=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
    'API="https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT}"',
    `printf '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"%s"},"type":"kubernetes.io/tls","data":{${dataFormat}}}' "${secret}" ${dataArgs.join(' ')} > secret.json`,
    `curl -sS --fail-with-body --cacert "$KUBECA" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/apply-patch+yaml" -X PATCH "\${API}/api/v1/namespaces/${namespace}/secrets/${secret}?fieldManager=${fieldManager}&force=true" --data-binary @secret.json`,
    `echo "CREATED ${secret}"`,
  ];
};

/**
 * HTTPS TLS secret Job: openssl mints a CA and a server leaf it signs. KBS
 * serves tls.crt/tls.key (the leaf); ca.crt is the trust anchor the workload
 * pins in its initdata.
 */
export const buildHttpsTlsSecretScript = (opts: SecretScriptOptions): string => {
  const { secret, cn, san, namespace } = opts;
  return [
    'set -e',
    'cd /tmp',
    // 1. CA (self-signed root) — the trust anchor the workload pins in its initdata.
    'openssl genrsa -out ca.key 2048',
    `openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -subj "/CN=${dq(cn)} Root CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca.crt`,
    // 2. Server leaf — end-entity (CA:FALSE), serverAuth EKU, SAN = the KBS hostnames.
    'openssl genrsa -out tls.key 2048',
    `openssl req -new -key tls.key -subj "/CN=${dq(cn)}" -out tls.csr`,
    `printf 'basicConstraints=critical,CA:FALSE\\nkeyUsage=critical,digitalSignature,keyEncipherment\\nextendedKeyUsage=serverAuth\\nsubjectAltName=${dq(san)}\\n' > leaf.ext`,
    'openssl x509 -req -in tls.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 -sha256 -extfile leaf.ext -out tls.crt',
    'B64CRT=$(base64 -w0 tls.crt)',
    'B64KEY=$(base64 -w0 tls.key)',
    'B64CA=$(base64 -w0 ca.crt)',
    ...applyTlsSecret({
      secret,
      namespace,
      // KBS serves tls.crt/tls.key (the leaf); ca.crt is the anchor the workload pins.
      dataFormat: '"tls.crt":"%s","tls.key":"%s","ca.crt":"%s"',
      dataArgs: ['"$B64CRT"', '"$B64KEY"', '"$B64CA"'],
      fieldManager: 'trustee-tls-gen',
    }),
  ].join('\n');
};

/**
 * Attestation-token TLS secret Job: openssl mints a self-signed ECDSA P-256
 * certificate and its private key in PKCS8 — the algorithm/encoding the Trustee
 * operator expects for signing and verifying attestation tokens. The Secret is
 * a plain kubernetes.io/tls with tls.crt/tls.key (matching cert-manager's
 * selfSigned output described in the Trustee docs).
 */
export const buildAttestationTokenSecretScript = (opts: SecretScriptOptions): string => {
  const { secret, cn, san, namespace } = opts;
  return [
    'set -e',
    'cd /tmp',
    // ECDSA P-256, exported as unencrypted PKCS8 — required by the KBS token signer.
    'openssl ecparam -name prime256v1 -genkey -noout -out ec.key',
    'openssl pkcs8 -topk8 -nocrypt -in ec.key -out tls.key',
    `openssl req -new -x509 -key tls.key -sha256 -days 825 -subj "/CN=${dq(cn)}" -addext "basicConstraints=critical,CA:FALSE" -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=serverAuth" -addext "subjectAltName=${dq(san)}" -out tls.crt`,
    'B64CRT=$(base64 -w0 tls.crt)',
    'B64KEY=$(base64 -w0 tls.key)',
    ...applyTlsSecret({
      secret,
      namespace,
      dataFormat: '"tls.crt":"%s","tls.key":"%s"',
      dataArgs: ['"$B64CRT"', '"$B64KEY"'],
      fieldManager: 'trustee-token-gen',
    }),
  ].join('\n');
};
