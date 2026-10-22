import { execSync } from 'child_process';

export function ocAvailable(): boolean {
  try {
    execSync('oc whoami', { stdio: 'pipe', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

export function oc(args: string): string {
  return execSync(`oc ${args}`, {
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** First Running pod with runtimeClassName starting with kata-cc. */
export function findKataCcPod(): { ns: string; name: string } | null {
  if (!ocAvailable()) return null;
  try {
    const json = oc(
      `get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"|"}{.metadata.name}{"|"}{.spec.runtimeClassName}{"|"}{.status.phase}{"\\n"}{end}'`,
    );
    for (const line of json.split('\n')) {
      const [ns, name, rc, phase] = line.split('|');
      if (ns && name && rc?.startsWith('kata-cc') && phase === 'Running') {
        return { ns, name };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}
