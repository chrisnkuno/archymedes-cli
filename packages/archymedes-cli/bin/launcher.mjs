// What `archymedes` runs, decided before anything is drawn: the Go interface for this platform, or
// the bundled TypeScript interface with the reason why. Pure apart from the lookups passed in, so
// every outcome is testable without installing anything (tooling/build/launcher.test.ts).

/** The platforms a Go interface is published for, as `${process.platform}-${process.arch}`. */
export const PUBLISHED_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];

export const interfacePackage = (platform, arch) => `@archymedes/cli-${platform}-${arch}`;

/**
 * @param {{ platform: string, arch: string, override?: string,
 *           resolvePackage: (name: string) => string | undefined,
 *           exists: (path: string) => boolean,
 *           join: (...parts: string[]) => string }} options
 * @returns {{ binary: string } | { reason: "unsupported" | "not-installed" | "missing-binary", packageName: string }}
 */
export function resolveInterface({ platform, arch, override, resolvePackage, exists, join }) {
  if (override) return { binary: override };
  const packageName = interfacePackage(platform, arch);
  if (!PUBLISHED_PLATFORMS.includes(`${platform}-${arch}`)) return { reason: "unsupported", packageName };
  // resolvePackage returns the package's directory, or undefined when npm did not install it.
  const directory = resolvePackage(packageName);
  if (!directory) return { reason: "not-installed", packageName };
  const binary = join(directory, "bin", platform === "win32" ? "archymedes.exe" : "archymedes");
  return exists(binary) ? { binary } : { reason: "missing-binary", packageName };
}

/**
 * Why the bundled interface is running instead, and the one command that fixes it — said before
 * it starts and again after it exits, because a full-screen interface hides whatever was printed
 * before it took the screen.
 */
export function fallbackNotice(resolution, platform, arch) {
  const reinstall = "npm install -g archymedes-cli@latest";
  switch (resolution.reason) {
    case "unsupported":
      return [`archymedes: no Go interface is published for ${platform}-${arch}; using the bundled one.`];
    case "not-installed":
      return [
        `archymedes: the Go interface (${resolution.packageName}) was not installed, so the bundled one is running.`,
        `  npm skips it when optional dependencies are off, or when the install ran before it reached the registry.`,
        `  Fix: ${reinstall}`,
      ];
    case "missing-binary":
      return [`archymedes: ${resolution.packageName} is installed without its binary; using the bundled interface.`, `  Fix: ${reinstall}`];
    case "start-failed":
      return [`archymedes: the Go interface could not start (${resolution.detail}); using the bundled one.`, `  Fix: ${reinstall}`];
    default:
      return [];
  }
}
