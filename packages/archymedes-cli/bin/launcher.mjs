// What `archymedes` runs, decided before anything is drawn: the Go interface for this platform, or
// — where it cannot be used — the bundled agent alone, which still serves every non-interactive mode. Pure apart from the lookups passed in, so
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
 * Why there is no interactive interface, the one command that fixes it, and what still works.
 *
 * The bundled agent shows it only when someone asks it for the interface (no request): a one-shot
 * run, `--json` or `settings` work the same with or without the binary, so they say nothing.
 */
export function missingInterfaceNotice(resolution, platform, arch) {
  const reinstall = "npm install -g archymedes-cli@latest";
  const works = `  Without it, only non-interactive modes work: archymedes "your request", --json, settings, history, doctor, update.`;
  switch (resolution.reason) {
    case "unsupported":
      return [`archymedes: no interactive interface is published for ${platform}-${arch}.`, works];
    case "not-installed":
      return [
        `archymedes: the interactive interface (${resolution.packageName}) was not installed.`,
        `  npm skips it when optional dependencies are off, or when the install ran before it reached the registry.`,
        `  Fix: ${reinstall}`,
        works,
      ];
    case "missing-binary":
      return [`archymedes: ${resolution.packageName} is installed without its binary.`, `  Fix: ${reinstall}`, works];
    case "start-failed":
      return [`archymedes: the interactive interface could not start (${resolution.detail}).`, `  Fix: ${reinstall}`, works];
    default:
      return [];
  }
}
