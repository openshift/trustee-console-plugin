// ---------------------------------------------------------------------------
// RVPS reference-values ConfigMap format.
//
// The Trustee operator (v1.2.0+, commit 5915fea) stores RVPS reference values in
// the `<tc>-rvps-reference-values` ConfigMap under the data key `reference_value`
// and subPath-mounts that one key into the RVPS storage directory
// (kbsconfig_controller.go). The value is RVPS's `local_json` storage format: a
// JSON object mapping reference-value name → URL-safe-base64 of the compact JSON
// serialization of that reference value:
//   {"init_data": "eyJ2ZXJzaW9uIjoiMC4xLjAiLCJuYW1lIjoiaW5pdF9kYXRhIiwuLi4="}
// Each encoded value is RVPS's `ReferenceValue` (rvps/src/reference_value.rs):
//   { "version": "0.1.0", "name": "...", "expiration": "YYYY-MM-DDTHH:MM:SSZ",
//     "value": <any JSON> }
//
// Operator v1.1 instead used the data key `reference-values.json` holding a plain
// JSON array of the same entries. The operator migrates the old key to the new
// format on upgrade (migration.go, `.v1.1` backup), and the plugin keeps reading
// the old key during the transition so it stays functional against an older
// operator. Writes always target the canonical `reference_value` key, merging
// with — never replacing — existing data; when the legacy key is present it is
// kept in sync, because a pre-v1.2 operator reads only that key while the
// operator's own v1.2 migration rebuilds `reference_value` from the legacy key —
// consistent keys mean no registration is lost either way.
// ---------------------------------------------------------------------------
import { RVPS_REFERENCE_VALUES_KEY, RVPS_REFERENCE_VALUES_LEGACY_KEY } from '../k8s/resources';
import type { ConfigMapKind } from '../k8s/types';

/** RVPS `ReferenceValue` schema version (rvps/src/reference_value.rs). */
export const REFERENCE_VALUE_VERSION = '0.1.0';

/** One RVPS reference value — the JSON carried (base64-encoded) in the map. */
export interface ReferenceValueEntry {
  /** Defaults to '0.1.0' when absent, matching RVPS's serde default. */
  version?: string;
  /** Artifact name; also the key it is stored under. */
  name: string;
  /** Invalid-after time, 'YYYY-MM-DDTHH:MM:SSZ' (RVPS parses second precision). */
  expiration: string;
  /** The measured value(s); any JSON (veritas emits an array of digests). */
  value: unknown;
}

/**
 * A parsed reference-values map: name → entry, or the undecodable raw string for
 * a value the plugin can't decode (kept verbatim on write so unknown data is
 * never destroyed).
 */
export type ReferenceValuesMap = Record<string, ReferenceValueEntry | string>;

/** JSON Patch operation that registers a reference value in the ConfigMap. */
export interface ReferenceValuesPatchOp {
  op: 'add' | 'test';
  path: string;
  value: string;
}

// RVPS's local_json backend base64-codes values with the URL-safe alphabet
// (deps/key-value-storage local_json, Rust URL_SAFE: `-`/`_`, padding kept).
// Browser atob/btoa speak the standard alphabet, so translate; UTF-8 is handled
// through TextEncoder/TextDecoder because the JSON payload is a byte string.
const utf8ToBase64Url = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_');
};

// Accepts both URL-safe and standard base64: the operator's v1.1→v1.2 migration
// writes standard base64 (migration.go base64Encode) while RVPS itself writes
// URL-safe, so a reader must tolerate either.
const base64UrlToUtf8 = (b64: string): string => {
  const binary = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
};

/** Compact JSON + URL-safe base64 — exactly what RVPS's local_json stores. */
export const encodeReferenceValue = (entry: ReferenceValueEntry): string =>
  utf8ToBase64Url(JSON.stringify(entry));

/**
 * Decode a stored value; undefined when it isn't a decodable reference value
 * (both base64 alphabets are accepted — see base64UrlToUtf8).
 */
export const decodeReferenceValue = (raw: string): ReferenceValueEntry | undefined => {
  try {
    const parsed: unknown = JSON.parse(base64UrlToUtf8(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const e = parsed as Record<string, unknown>;
    if (typeof e.name !== 'string') return undefined;
    return {
      version: typeof e.version === 'string' ? e.version : undefined,
      name: e.name,
      expiration: typeof e.expiration === 'string' ? e.expiration : '',
      value: e.value,
    };
  } catch {
    return undefined;
  }
};

/**
 * Serialize the canonical `reference_value` payload (pretty-printed, like the
 * operator's migration output). Undecodable values pass through verbatim.
 */
export const serializeReferenceValuesMap = (map: ReferenceValuesMap): string => {
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(map)) {
    out[name] = typeof v === 'string' ? v : encodeReferenceValue(v);
  }
  return JSON.stringify(out, null, 2);
};

/**
 * Parse the operator ≤ v1.1 `reference-values.json` array. Undefined when the
 * payload is absent or not a parseable array — entries without a name are
 * skipped, matching the operator's own migration behavior.
 */
export const parseLegacyReferenceValues = (
  raw: string | undefined,
): ReferenceValueEntry[] | undefined => {
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const entries: ReferenceValueEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const e = item as Record<string, unknown>;
      if (typeof e.name !== 'string') continue;
      entries.push({
        version: typeof e.version === 'string' ? e.version : undefined,
        name: e.name,
        expiration: typeof e.expiration === 'string' ? e.expiration : '',
        value: e.value,
      });
    }
    return entries;
  } catch {
    return undefined;
  }
};

/**
 * Build the JSON Patch that registers `entry` in the reference-values ConfigMap,
 * merging with — never replacing — its current data:
 *   - entries under the canonical `reference_value` key are authoritative and
 *     kept (values the plugin can't decode are preserved verbatim);
 *   - entries under the legacy `reference-values.json` key (operator ≤ v1.1) are
 *     carried over, so the switch to the canonical key drops nothing;
 *   - when the legacy key is present it is rewritten too, so a pre-v1.2 operator
 *     still sees the registration, and the operator's own v1.2 migration (which
 *     rebuilds `reference_value` from the legacy key) converges to the same data.
 *
 * The patch is guarded by a `test` on the ConfigMap's `metadata.resourceVersion`
 * when known: JSON Patch otherwise carries no optimistic concurrency, so two
 * concurrent registrations would silently lose whichever writer lands first.
 * A failed test rejects the whole patch (HTTP 422) — the caller re-reads,
 * re-merges, and retries.
 *
 * Throws when the canonical key holds data that isn't a reference-values map —
 * overwriting it would destroy data the plugin doesn't understand.
 */
export const registerReferenceValue = (
  cm: ConfigMapKind | undefined,
  entry: ReferenceValueEntry,
): ReferenceValuesPatchOp[] => {
  const cmData = cm?.data;
  const canonicalRaw = cmData?.[RVPS_REFERENCE_VALUES_KEY];
  const legacyRaw = cmData?.[RVPS_REFERENCE_VALUES_LEGACY_KEY];

  // Legacy entries land first so canonical entries win any name collision.
  const merged: ReferenceValuesMap = {};
  const legacyEntries = parseLegacyReferenceValues(legacyRaw);
  if (legacyEntries) {
    for (const e of legacyEntries) merged[e.name] = e;
  }

  if (canonicalRaw !== undefined && canonicalRaw.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(canonicalRaw);
    } catch {
      throw new Error(
        `the ${RVPS_REFERENCE_VALUES_KEY} key holds unparseable data; refusing to overwrite it`,
      );
    }
    if (Array.isArray(parsed)) {
      // The legacy array format under the canonical key — repair it into the map.
      for (const e of parseLegacyReferenceValues(canonicalRaw) ?? []) merged[e.name] = e;
    } else if (parsed && typeof parsed === 'object') {
      for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          throw new Error(
            `the ${RVPS_REFERENCE_VALUES_KEY} key holds a non-string entry for '${name}'; refusing to overwrite it`,
          );
        }
        merged[name] = decodeReferenceValue(v) ?? v;
      }
    } else {
      throw new Error(
        `the ${RVPS_REFERENCE_VALUES_KEY} key does not hold a reference-values map; refusing to overwrite it`,
      );
    }
  }

  merged[entry.name] = entry;

  const ops: ReferenceValuesPatchOp[] = [
    {
      op: 'add',
      path: `/data/${RVPS_REFERENCE_VALUES_KEY}`,
      value: serializeReferenceValuesMap(merged),
    },
  ];
  const resourceVersion = cm?.metadata?.resourceVersion;
  if (resourceVersion) {
    ops.unshift({ op: 'test', path: '/metadata/resourceVersion', value: resourceVersion });
  }
  if (legacyRaw !== undefined && legacyEntries) {
    const arr = Object.values(merged).filter(
      (v): v is ReferenceValueEntry => typeof v !== 'string',
    );
    ops.push({
      op: 'add',
      path: `/data/${RVPS_REFERENCE_VALUES_LEGACY_KEY}`,
      value: JSON.stringify(arr, null, 2),
    });
  }
  return ops;
};

/**
 * True when either key holds at least one reference value — the canonical key
 * first, then the legacy key (operator ≤ v1.1 skew). A JSON array counts
 * entries, an object counts keys, and a non-empty unparseable payload counts as
 * present, so a hand-edited ConfigMap is never reported as empty.
 */
export const referenceValuesPopulated = (data: Record<string, string> | undefined): boolean => {
  for (const key of [RVPS_REFERENCE_VALUES_KEY, RVPS_REFERENCE_VALUES_LEGACY_KEY]) {
    const raw = (data?.[key] ?? '').trim();
    if (raw === '' || raw === '[]' || raw === '{}') continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        if (parsed.length > 0) return true;
      } else if (parsed && typeof parsed === 'object') {
        if (Object.keys(parsed).length > 0) return true;
      }
    } catch {
      return true;
    }
  }
  return false;
};

/**
 * True when `needle` occurs in either key's raw payload — reference-value names
 * appear as plain JSON (map key / array name field), never base64-encoded.
 */
export const referenceValuesIncludeName = (
  data: Record<string, string> | undefined,
  needle: string,
): boolean =>
  [RVPS_REFERENCE_VALUES_KEY, RVPS_REFERENCE_VALUES_LEGACY_KEY].some((k) =>
    (data?.[k] ?? '').includes(needle),
  );
