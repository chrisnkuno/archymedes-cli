/**
 * The invocation that sets `ARCHYMEDES_HOOK_EVENT_B64` for one hook script, per shell.
 *
 * `env VAR=value program` is a POSIX idiom and `env` is not a program on Windows at all, so the
 * original spelling did not merely misbehave under cmd.exe — it failed to find anything to run.
 * cmd's own equivalent is `set` followed by the command, which needs `&&` and therefore a real
 * shell; `hasShellSyntax` sees the `&&` and routes it accordingly, which is exactly what is wanted
 * here. A base64 payload never contains a character either shell treats as special, so neither
 * form needs quoting around it.
 */
export function hookCommand(scriptPath: string, payload: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return `env ARCHYMEDES_HOOK_EVENT_B64=${payload} ${scriptPath}`;
  return `set "ARCHYMEDES_HOOK_EVENT_B64=${payload}"&& call "${scriptPath.split("/").join("\\")}"`;
}
