## Injection

- **SQL/NoSQL**: string-built queries (concatenation, template literals, f-strings) instead of
  parameterized queries or an ORM's bound-parameter API. Grep for query-building near `req.`,
  `params`, `query`, or any user-controlled variable.
- **Command injection**: `exec`/`spawn`/`system`/backticks built from user input without an
  argument array (`execFile`, `spawn(cmd, [args])`) or without an allowlist of the command itself.
- **Template injection (SSTI)**: user input rendered through a template engine's raw/unescaped mode,
  or user input used to select *which* template to render.
- **Path traversal**: a filename, path segment, or archive-member path taken from user input and
  joined onto a base directory without resolving and checking it stays inside that directory
  (`../../etc/passwd`, a zip/tar entry with an absolute or `../` path).
- **XXE / unsafe deserialization**: an XML parser with external entities enabled, or a
  deserializer (pickle, YAML `load` instead of `safe_load`, Java `ObjectInputStream`,
  `unserialize`) fed data from outside the process.
- **Header/log injection**: user input written into an HTTP response header or a log line without
  stripping CR/LF, letting an attacker split the response or forge log entries.

**How to check it**: grep for the sink (the query call, the shell call, the template render, the
path join) and trace backward to its argument. A sink fed only by a literal or a value the server
itself generated is not a finding; one fed by anything reachable from a request, a file the server
reads, or a queue message is.
