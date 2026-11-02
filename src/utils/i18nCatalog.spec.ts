// Regression coverage for i18n catalog misfiling: `ns` is i18next's reserved
// namespace option. Passing it as an interpolation value in a t() call sends the
// runtime lookup to a nonexistent namespace and makes i18next-parser emit the key
// into a bogus catalog file (e.g. locales/en/hubNs.json), so the string never
// resolves through the plugin translation catalog and cannot be translated.
// Use a different interpolation name (the repo convention is `nsName`).
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const repoRoot = join(__dirname, '..', '..');
const srcDir = join(repoRoot, 'src');
const localesDir = join(repoRoot, 'locales', 'en');
const CATALOG_FILE = 'plugin__trustee-openshift-console-plugin.json';

const collectSourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return collectSourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) && !/\.spec\.(ts|tsx)$/.test(entry) ? [full] : [];
  });

const catalog: Record<string, string> = JSON.parse(
  readFileSync(join(localesDir, CATALOG_FILE), 'utf8'),
);

// The destructured useTranslation `t` called with a single-quoted literal key
// (not .get(…), .split(…), etc. — the lookbehind excludes member calls).
const tCall = /(?<![A-Za-z0-9_$.])t\(\s*'((?:[^'\\]|\\.)*)'/g;
// t('literal', { … ns: … }) — the reserved i18next namespace option used as an
// interpolation value. Options objects passed to t() are flat.
const reservedNsOption = /(?<![A-Za-z0-9_$.])t\(\s*'(?:[^'\\]|\\.)*'\s*,\s*\{[^{}]*?\bns\s*:/;

const resolvesThroughCatalog = (key: string): boolean =>
  catalog[key] !== undefined ||
  catalog[`${key}_one`] !== undefined ||
  catalog[`${key}_other`] !== undefined;

describe('i18n: every t() string resolves through the plugin translation catalog', () => {
  const files = collectSourceFiles(srcDir);
  const texts = files.map((file) => ({ file, text: readFileSync(file, 'utf8') }));

  it('found source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no t() call passes the reserved ns option as an interpolation value', () => {
    const offenders = texts
      .filter(({ text }) => reservedNsOption.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('every t() literal key exists in the plugin catalog', () => {
    const missing = texts.flatMap(({ file, text }) =>
      [...text.matchAll(tCall)]
        .map((m) => m[1].replace(/\\'/g, "'"))
        .filter((key) => !resolvesThroughCatalog(key))
        .map((key) => `${file}: ${key}`),
    );
    expect(missing).toEqual([]);
  });

  it('locales/en holds no keys outside the plugin catalog', () => {
    const stray = readdirSync(localesDir)
      .filter((f) => f.endsWith('.json') && f !== CATALOG_FILE)
      .filter((f) => Object.keys(JSON.parse(readFileSync(join(localesDir, f), 'utf8'))).length > 0);
    expect(stray).toEqual([]);
  });
});
