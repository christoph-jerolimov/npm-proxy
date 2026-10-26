import { SEVERITIES, type Config, type Severity } from "./config.js";
import type { Advisory, Packument } from "./registry.js";

export type Verdict =
  | { allow: true }
  | {
      allow: false;
      /** Short machine-friendly reasons, e.g. "deprecated", "insecure". */
      codes: string[];
      /** Human readable explanation, one line each. */
      reasons: string[];
      recommendation: string;
    };

const rank = (severity: string): number => {
  const index = SEVERITIES.indexOf(severity as Severity);
  return index === -1 ? 0 : index;
};

/**
 * Decides whether `name@version` may be served, based on the package document
 * and the advisories for that version.
 */
export function evaluate(
  name: string,
  version: string,
  packument: Packument,
  advisories: Advisory[],
  deny: Config["deny"],
): Verdict {
  const codes: string[] = [];
  const reasons: string[] = [];
  const entry = packument.versions[version];

  if (deny.deprecated && entry?.deprecated) {
    codes.push("deprecated");
    reasons.push(`deprecated: ${entry.deprecated.trim()}`);
  }

  if (deny.insecure) {
    const relevant = advisories
      .filter((a) => rank(a.severity) >= rank(deny.minSeverity))
      .sort((a, b) => rank(b.severity) - rank(a.severity));
    if (relevant.length > 0) {
      codes.push("insecure");
      for (const a of relevant) {
        reasons.push(`${a.severity} severity: ${a.title} (${a.url})`);
      }
    }
  }

  if (codes.length === 0) return { allow: true };

  return { allow: false, codes, reasons, recommendation: recommend(name, version, packument, codes) };
}

function recommend(name: string, version: string, packument: Packument, codes: string[]): string {
  const latest = packument["dist-tags"]?.latest;
  const latestEntry = latest ? packument.versions[latest] : undefined;

  if (latest && latest !== version && latestEntry && !latestEntry.deprecated) {
    return `upgrade to ${name}@${latest} (latest) and check that it is not affected by the advisories above`;
  }
  if (latestEntry?.deprecated) {
    return `every release of ${name} is deprecated; look for a maintained replacement: ${latestEntry.deprecated.trim()}`;
  }
  if (codes.includes("insecure")) {
    return `${name}@${version} is the latest release and still affected; wait for a fixed release or pick an alternative package`;
  }
  return `pick a different release of ${name}`;
}
