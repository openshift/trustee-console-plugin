import {
  decodeReferenceValue,
  encodeReferenceValue,
  parseLegacyReferenceValues,
  referenceValuesIncludeName,
  referenceValuesPopulated,
  registerReferenceValue,
  serializeReferenceValuesMap,
  type ReferenceValueEntry,
  type ReferenceValuesPatchOp,
} from './referenceValues';
import { RVPS_REFERENCE_VALUES_KEY, RVPS_REFERENCE_VALUES_LEGACY_KEY } from '../k8s/resources';

// The entry shape the Initdata tab registers (utils/initdata measurement).
const initdataEntry = (name = 'init_data'): ReferenceValueEntry => ({
  version: '0.1.0',
  name,
  expiration: '2099-12-31T00:00:00Z',
  value: ['0123456789abcdef'],
});

/** The canonical patch op's value — the serialized reference-values map. */
const canonicalValue = (ops: ReferenceValuesPatchOp[]): string => {
  const op = ops.find((o) => o.path === `/data/${RVPS_REFERENCE_VALUES_KEY}`);
  if (!op) throw new Error('no canonical patch op');
  return op.value;
};

/** Decode a serialized map back into {name: entry-or-undefined}. */
const decodedMap = (raw: string): Record<string, ReferenceValueEntry | undefined> => {
  const parsed = JSON.parse(raw) as Record<string, string>;
  const out: Record<string, ReferenceValueEntry | undefined> = {};
  for (const [k, v] of Object.entries(parsed)) {
    out[k] = decodeReferenceValue(v);
  }
  return out;
};

describe('encodeReferenceValue / decodeReferenceValue', () => {
  it('round-trips an entry through URL-safe base64 of its compact JSON', () => {
    const entry = initdataEntry();
    const encoded = encodeReferenceValue(entry);
    // URL-safe alphabet (RVPS local_json's Rust URL_SAFE), padding kept.
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+={0,2}$/);
    // The encoded payload is the compact JSON serialization, not pretty-printed.
    expect(atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))).toBe(
      '{"version":"0.1.0","name":"init_data","expiration":"2099-12-31T00:00:00Z","value":["0123456789abcdef"]}',
    );
    expect(decodeReferenceValue(encoded)).toEqual(entry);
  });

  it('round-trips non-ASCII values (UTF-8 payload)', () => {
    const entry: ReferenceValueEntry = {
      version: '0.1.0',
      name: 'ünïcode',
      expiration: '2099-12-31T00:00:00Z',
      value: 'välue-ü',
    };
    expect(decodeReferenceValue(encodeReferenceValue(entry))).toEqual(entry);
  });

  it('decodes standard-base64 values (the operator migration writes StdEncoding)', () => {
    // The operator's v1.1→v1.2 migration (migration.go base64Encode) uses
    // standard base64 while RVPS writes URL-safe; a reader must accept both.
    // The name 'aþ' (U+00FE → UTF-8 C3 BE) makes the standard encoding contain
    // a '+', so the two alphabets genuinely differ for this payload.
    const entry: ReferenceValueEntry = {
      version: '0.1.0',
      name: 'aþ',
      expiration: '2099-12-31T00:00:00Z',
      value: ['0123456789abcdef'],
    };
    const std =
      'eyJ2ZXJzaW9uIjoiMC4xLjAiLCJuYW1lIjoiYcO+IiwiZXhwaXJhdGlvbiI6IjIwOTktMTItMzFUMDA6MDA6MDBaIiwidmFsdWUiOlsiMDEyMzQ1Njc4OWFiY2RlZiJdfQ==';
    expect(decodeReferenceValue(std)).toEqual(entry); // operator migration output
    expect(decodeReferenceValue(std.replace(/\+/g, '-'))).toEqual(entry); // URL-safe form
    expect(encodeReferenceValue(entry)).toBe(std.replace(/\+/g, '-')); // the plugin writes URL-safe
  });

  it('returns undefined for undecodable values', () => {
    expect(decodeReferenceValue('!!!not-base64!!!')).toBeUndefined();
    expect(decodeReferenceValue('')).toBeUndefined();
    expect(decodeReferenceValue(btoa('not json'))).toBeUndefined();
    expect(decodeReferenceValue(btoa('[1,2]'))).toBeUndefined();
    expect(decodeReferenceValue(btoa('null'))).toBeUndefined();
    expect(decodeReferenceValue(btoa('"just a string"'))).toBeUndefined();
    expect(decodeReferenceValue(btoa('{"expiration":"x"}'))).toBeUndefined(); // no name
  });
});

describe('parseLegacyReferenceValues', () => {
  it('parses the v1.1 array format', () => {
    const raw = JSON.stringify([
      { name: 'svn', expiration: '2027-01-01T00:00:00Z', value: 1 },
      { name: 'init_data', expiration: '2099-12-31T00:00:00Z', value: ['abc'] },
    ]);
    expect(parseLegacyReferenceValues(raw)).toEqual([
      { version: undefined, name: 'svn', expiration: '2027-01-01T00:00:00Z', value: 1 },
      { version: undefined, name: 'init_data', expiration: '2099-12-31T00:00:00Z', value: ['abc'] },
    ]);
  });

  it('skips nameless entries (like the operator migration) and tolerates versions', () => {
    const raw = JSON.stringify([{ value: 1 }, { name: 'a', version: '9.9.9', value: 2 }]);
    expect(parseLegacyReferenceValues(raw)).toEqual([
      { version: '9.9.9', name: 'a', expiration: '', value: 2 },
    ]);
  });

  it('returns undefined for absent, empty, or non-array payloads', () => {
    expect(parseLegacyReferenceValues(undefined)).toBeUndefined();
    expect(parseLegacyReferenceValues('')).toBeUndefined();
    expect(parseLegacyReferenceValues('  ')).toBeUndefined();
    expect(parseLegacyReferenceValues('{"a":1}')).toBeUndefined();
    expect(parseLegacyReferenceValues('not json')).toBeUndefined();
  });
});

describe('registerReferenceValue', () => {
  it('creates only the canonical key when the ConfigMap has no data', () => {
    const ops = registerReferenceValue(undefined, initdataEntry());
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'add', path: '/data/reference_value' });
    const map = decodedMap(ops[0].value);
    expect(map.init_data).toEqual(initdataEntry());
  });

  it("guards the patch with a test on the ConfigMap's resourceVersion when known", () => {
    // JSON Patch carries no optimistic concurrency by itself: without the test
    // op, two concurrent registrations are last-writer-wins on the whole key and
    // the losing side's entry is silently lost.
    const ops = registerReferenceValue(
      {
        metadata: { resourceVersion: '4242' },
        data: {
          [RVPS_REFERENCE_VALUES_KEY]: serializeReferenceValuesMap({
            svn: { name: 'svn', expiration: '2027-01-01T00:00:00Z', value: 1 },
          }),
        },
      },
      initdataEntry(),
    );
    expect(ops[0]).toEqual({ op: 'test', path: '/metadata/resourceVersion', value: '4242' });
    expect(ops.slice(1).every((o) => o.op === 'add')).toBe(true);
    const map = decodedMap(canonicalValue(ops));
    expect(map.svn).toBeDefined();
    expect(map.init_data).toEqual(initdataEntry());
  });

  it('omits the test op when no resourceVersion is known', () => {
    const ops = registerReferenceValue({ data: {} }, initdataEntry());
    expect(ops.some((o) => o.op === 'test')).toBe(false);
  });

  it('registers into an empty canonical map', () => {
    const ops = registerReferenceValue(
      { data: { [RVPS_REFERENCE_VALUES_KEY]: '{}' } },
      initdataEntry(),
    );
    const map = decodedMap(canonicalValue(ops));
    expect(Object.keys(map)).toEqual(['init_data']);
  });

  it('keeps the last entry when the legacy array has duplicate names', () => {
    const ops = registerReferenceValue(
      {
        data: {
          [RVPS_REFERENCE_VALUES_LEGACY_KEY]: JSON.stringify([
            { name: 'svn', value: 'first' },
            { name: 'svn', value: 'second' },
          ]),
        },
      },
      initdataEntry(),
    );
    const map = decodedMap(canonicalValue(ops));
    expect(map.svn).toEqual({ version: undefined, name: 'svn', expiration: '', value: 'second' });
  });

  it('merges into an existing canonical map without dropping entries', () => {
    const existing = {
      [RVPS_REFERENCE_VALUES_KEY]: serializeReferenceValuesMap({
        svn: { name: 'svn', expiration: '2027-01-01T00:00:00Z', value: 1 },
      }),
    };
    const ops = registerReferenceValue({ data: existing }, initdataEntry());
    expect(ops).toHaveLength(1);
    const map = decodedMap(canonicalValue(ops));
    expect(map.svn).toEqual({
      version: undefined,
      name: 'svn',
      expiration: '2027-01-01T00:00:00Z',
      value: 1,
    });
    expect(map.init_data).toEqual(initdataEntry());
  });

  it('upserts by name — an existing entry with the same name is replaced', () => {
    const existing = {
      [RVPS_REFERENCE_VALUES_KEY]: serializeReferenceValuesMap({
        init_data: { name: 'init_data', expiration: '2020-01-01T00:00:00Z', value: ['old'] },
      }),
    };
    const ops = registerReferenceValue({ data: existing }, initdataEntry());
    const map = decodedMap(canonicalValue(ops));
    expect(Object.keys(map)).toEqual(['init_data']);
    expect(map.init_data).toEqual(initdataEntry());
  });

  it('carries legacy-key entries into the canonical map and keeps the legacy key in sync', () => {
    const existing = {
      [RVPS_REFERENCE_VALUES_LEGACY_KEY]: JSON.stringify([
        { name: 'svn', expiration: '2027-01-01T00:00:00Z', value: 1 },
      ]),
    };
    const ops = registerReferenceValue({ data: existing }, initdataEntry());
    expect(ops.map((o) => o.path)).toEqual([
      `/data/${RVPS_REFERENCE_VALUES_KEY}`,
      `/data/${RVPS_REFERENCE_VALUES_LEGACY_KEY}`,
    ]);
    const map = decodedMap(canonicalValue(ops));
    expect(map.svn).toBeDefined();
    expect(map.init_data).toEqual(initdataEntry());
    // The legacy array is rewritten with the SAME merged entries, so a pre-v1.2
    // operator (and the operator's own v1.2 migration, which rebuilds the
    // canonical key from the legacy one) both see the registration.
    const legacyOp = ops.find((o) => o.path === `/data/${RVPS_REFERENCE_VALUES_LEGACY_KEY}`);
    expect(JSON.parse(legacyOp?.value ?? '[]')).toEqual([
      { name: 'svn', expiration: '2027-01-01T00:00:00Z', value: 1 },
      {
        version: '0.1.0',
        name: 'init_data',
        expiration: '2099-12-31T00:00:00Z',
        value: ['0123456789abcdef'],
      },
    ]);
  });

  it('lets canonical entries win name collisions with legacy entries', () => {
    const existing = {
      [RVPS_REFERENCE_VALUES_KEY]: serializeReferenceValuesMap({
        svn: { name: 'svn', expiration: '2030-01-01T00:00:00Z', value: 'canonical' },
      }),
      [RVPS_REFERENCE_VALUES_LEGACY_KEY]: JSON.stringify([
        { name: 'svn', expiration: '2027-01-01T00:00:00Z', value: 'legacy' },
      ]),
    };
    const ops = registerReferenceValue({ data: existing }, initdataEntry());
    const map = decodedMap(canonicalValue(ops));
    expect(map.svn).toEqual({
      version: undefined,
      name: 'svn',
      expiration: '2030-01-01T00:00:00Z',
      value: 'canonical',
    });
  });

  it('repairs the legacy array format found under the canonical key', () => {
    const existing = {
      [RVPS_REFERENCE_VALUES_KEY]: JSON.stringify([
        { name: 'svn', expiration: '2027-01-01T00:00:00Z', value: 1 },
      ]),
    };
    const ops = registerReferenceValue({ data: existing }, initdataEntry());
    expect(ops).toHaveLength(1);
    const map = decodedMap(canonicalValue(ops));
    expect(map.svn).toBeDefined();
    expect(map.init_data).toEqual(initdataEntry());
  });

  it('preserves canonical values it cannot decode instead of clobbering them', () => {
    const existing = {
      [RVPS_REFERENCE_VALUES_KEY]: JSON.stringify({ weird: '!!!not-decodable!!!' }),
    };
    const ops = registerReferenceValue({ data: existing }, initdataEntry());
    const map = JSON.parse(canonicalValue(ops)) as Record<string, string>;
    expect(map.weird).toBe('!!!not-decodable!!!');
    expect(decodeReferenceValue(map.init_data ?? '')).toEqual(initdataEntry());
  });

  it('refuses to write when the canonical key holds unparseable data', () => {
    const existing = { [RVPS_REFERENCE_VALUES_KEY]: 'not json at all' };
    expect(() => registerReferenceValue({ data: existing }, initdataEntry())).toThrow(
      /reference_value/,
    );
  });

  it('refuses to write when the canonical key holds a non-map payload', () => {
    expect(() =>
      registerReferenceValue({ data: { [RVPS_REFERENCE_VALUES_KEY]: '12345' } }, initdataEntry()),
    ).toThrow(/reference_value/);
    expect(() =>
      registerReferenceValue(
        { data: { [RVPS_REFERENCE_VALUES_KEY]: '"a string"' } },
        initdataEntry(),
      ),
    ).toThrow(/reference_value/);
    expect(() =>
      registerReferenceValue({ data: { [RVPS_REFERENCE_VALUES_KEY]: 'null' } }, initdataEntry()),
    ).toThrow(/reference_value/);
    expect(() =>
      registerReferenceValue({ data: { [RVPS_REFERENCE_VALUES_KEY]: 'true' } }, initdataEntry()),
    ).toThrow(/reference_value/);
  });

  it('refuses to write when a canonical entry is not a string', () => {
    const existing = { [RVPS_REFERENCE_VALUES_KEY]: '{"svn": {"value": 1}}' };
    expect(() => registerReferenceValue({ data: existing }, initdataEntry())).toThrow(
      /reference_value/,
    );
  });

  it('leaves an unparseable legacy key untouched but still writes the canonical key', () => {
    const existing = { [RVPS_REFERENCE_VALUES_LEGACY_KEY]: 'garbage' };
    const ops = registerReferenceValue({ data: existing }, initdataEntry());
    expect(ops).toHaveLength(1);
    expect(ops[0].path).toBe(`/data/${RVPS_REFERENCE_VALUES_KEY}`);
  });

  it('does not create a legacy key when only the canonical key exists', () => {
    const existing = {
      [RVPS_REFERENCE_VALUES_KEY]: serializeReferenceValuesMap({
        svn: { name: 'svn', expiration: '2027-01-01T00:00:00Z', value: 1 },
      }),
    };
    const ops = registerReferenceValue({ data: existing }, initdataEntry());
    expect(ops.map((o) => o.path)).toEqual([`/data/${RVPS_REFERENCE_VALUES_KEY}`]);
  });
});

describe('referenceValuesPopulated', () => {
  it('is false for absent, empty, and placeholder payloads', () => {
    expect(referenceValuesPopulated(undefined)).toBe(false);
    expect(referenceValuesPopulated({})).toBe(false);
    expect(referenceValuesPopulated({ [RVPS_REFERENCE_VALUES_KEY]: '' })).toBe(false);
    expect(referenceValuesPopulated({ [RVPS_REFERENCE_VALUES_KEY]: '{}' })).toBe(false);
    expect(referenceValuesPopulated({ [RVPS_REFERENCE_VALUES_KEY]: '[]' })).toBe(false);
  });

  it('is true when the canonical key holds a non-empty map (operator ≥ v1.2)', () => {
    const data = {
      [RVPS_REFERENCE_VALUES_KEY]: serializeReferenceValuesMap({ init_data: initdataEntry() }),
    };
    expect(referenceValuesPopulated(data)).toBe(true);
  });

  it('is true when only the legacy key holds entries (operator ≤ v1.1 skew)', () => {
    const data = {
      [RVPS_REFERENCE_VALUES_LEGACY_KEY]: JSON.stringify([{ name: 'init_data', value: ['x'] }]),
    };
    expect(referenceValuesPopulated(data)).toBe(true);
    expect(referenceValuesPopulated({ [RVPS_REFERENCE_VALUES_LEGACY_KEY]: '[]' })).toBe(false);
  });

  it('treats a non-empty unparseable payload as present (hand-edited ConfigMap)', () => {
    expect(referenceValuesPopulated({ [RVPS_REFERENCE_VALUES_KEY]: 'hand-edited!!' })).toBe(true);
  });
});

describe('referenceValuesIncludeName', () => {
  it('finds names in the canonical map (plain JSON keys, never encoded)', () => {
    const data = {
      [RVPS_REFERENCE_VALUES_KEY]: serializeReferenceValuesMap({ init_data: initdataEntry() }),
    };
    expect(referenceValuesIncludeName(data, 'init_data')).toBe(true);
    expect(referenceValuesIncludeName(data, 'pcr08')).toBe(false);
  });

  it('finds names in the legacy array format', () => {
    const data = {
      [RVPS_REFERENCE_VALUES_LEGACY_KEY]: JSON.stringify([{ name: 'pcr08', value: ['x'] }]),
    };
    expect(referenceValuesIncludeName(data, 'pcr08')).toBe(true);
  });

  it('is false when neither key holds the name', () => {
    expect(referenceValuesIncludeName(undefined, 'init_data')).toBe(false);
    expect(referenceValuesIncludeName({}, 'init_data')).toBe(false);
  });
});
