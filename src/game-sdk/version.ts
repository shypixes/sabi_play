/**
 * Game SDK versioning.
 *
 * - SDK_VERSION follows semantic versioning. Games declare the SDK range they support in their
 *   manifest (`sdk.min` inclusive, `sdk.maxExclusive` exclusive) and the platform refuses to
 *   register or launch a game whose range does not include SDK_VERSION.
 * - PROTOCOL_VERSION is the version of the host <-> game message contract (src/game-sdk/protocol.ts).
 *   It changes only with a breaking message change, which also requires a new SDK major version.
 */
export const SDK_VERSION = "1.0.0";
export const PROTOCOL_VERSION = 1;

/** Strict MAJOR.MINOR.PATCH (no pre-release or build suffix; leading zeros not allowed). */
export const SEMVER_PATTERN = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export type Semver = { major: number; minor: number; patch: number };

export function parseSemver(version: string): Semver | null {
  const m = SEMVER_PATTERN.exec(version);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Negative when a < b, 0 when equal, positive when a > b. Throws on invalid input. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`Invalid semantic version: ${!pa ? a : b}`);
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

export type SdkRange = { min: string; maxExclusive: string };

/** True when `version` is within [min, maxExclusive). */
export function isInSdkRange(version: string, range: SdkRange): boolean {
  return compareSemver(version, range.min) >= 0 && compareSemver(version, range.maxExclusive) < 0;
}

/**
 * Host/game runtime compatibility: the same protocol, and the same SDK major version.
 * (Within one major version the protocol is backwards compatible by policy.)
 */
export function isRuntimeCompatible(a: { protocol: number; sdkVersion: string }, b: { protocol: number; sdkVersion: string }): boolean {
  const va = parseSemver(a.sdkVersion);
  const vb = parseSemver(b.sdkVersion);
  return a.protocol === b.protocol && va !== null && vb !== null && va.major === vb.major;
}
