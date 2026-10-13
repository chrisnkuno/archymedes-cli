export declare const PUBLISHED_PLATFORMS: readonly string[];
export declare function interfacePackage(platform: string, arch: string): string;

export type Resolution =
  | { binary: string }
  | { reason: "unsupported" | "not-installed" | "missing-binary"; packageName: string };

export declare function resolveInterface(options: {
  platform: string;
  arch: string;
  override?: string;
  resolvePackage: (name: string) => string | undefined;
  exists: (path: string) => boolean;
  join: (...parts: string[]) => string;
}): Resolution;

export declare function fallbackNotice(
  resolution: Resolution | { reason: "start-failed"; detail: string },
  platform: string,
  arch: string,
): string[];
