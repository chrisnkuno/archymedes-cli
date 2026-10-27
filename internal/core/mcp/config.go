// Package mcp connects Friday to Model Context Protocol servers: it reads which servers a project
// and the person declared, lists their tools, and calls them. Its tools are always deferred: none
// is sent with a request until tool_search finds it or the model names it, and a server whose tool
// list is cached is not even started until one of its tools is called, so a server that is not used
// costs neither context nor a process.
package mcp

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Server is one declared MCP server: a program on stdio, or a URL (streamable HTTP).
type Server struct {
	ID      string            `json:"id"`
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	URL     string            `json:"url,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	// From is the file that declared it.
	From string `json:"-"`
}

// Files are where servers are declared, first wins on a shared id: Friday's own project file,
// the project's .mcp.json (the format Claude Code and others read), then the person's own.
func Files(root, configDir string) []string {
	files := []string{filepath.Join(root, ".archymedes", "mcp.json"), filepath.Join(root, ".mcp.json")}
	if configDir != "" {
		files = append(files, filepath.Join(configDir, "mcp.json"))
	}
	return files
}

// Load reads every declared server, and what was wrong with any file or entry it skipped. A missing
// file is no servers: most projects have none.
func Load(files []string, getenv func(string) string) ([]Server, []string) {
	seen := map[string]bool{}
	var servers []Server
	var problems []string
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		found, err := parse(data, getenv)
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s: %v", file, err))
			continue
		}
		for _, s := range found {
			if problem := s.check(); problem != "" {
				problems = append(problems, fmt.Sprintf("%s: server %q %s", file, s.ID, problem))
				continue
			}
			if seen[s.ID] {
				continue
			}
			seen[s.ID] = true
			s.From = file
			servers = append(servers, s)
		}
	}
	return servers, problems
}

// parse reads either shape: Friday's `{"servers": [{"id": …}]}`, or the common
// `{"mcpServers": {"<id>": {…}}}` with `type` http or sse for a URL. Values may name environment
// variables as ${VAR} or ${VAR:-default}, as .mcp.json files do.
func parse(data []byte, getenv func(string) string) ([]Server, error) {
	var file struct {
		Servers    []Server                   `json:"servers"`
		MCPServers map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, fmt.Errorf("not valid JSON (%v)", err)
	}
	out := file.Servers
	ids := make([]string, 0, len(file.MCPServers))
	for id := range file.MCPServers {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		var s Server
		if err := json.Unmarshal(file.MCPServers[id], &s); err != nil {
			return nil, fmt.Errorf("server %q: %v", id, err)
		}
		s.ID = id
		out = append(out, s)
	}
	for i := range out {
		out[i].expand(getenv)
	}
	return out, nil
}

var variable = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}`)

func (s *Server) expand(getenv func(string) string) {
	sub := func(v string) string {
		return variable.ReplaceAllStringFunc(v, func(m string) string {
			parts := variable.FindStringSubmatch(m)
			if value := getenv(parts[1]); value != "" {
				return value
			}
			return parts[2]
		})
	}
	s.Command, s.URL = sub(s.Command), sub(s.URL)
	for i, a := range s.Args {
		s.Args[i] = sub(a)
	}
	for k, v := range s.Env {
		s.Env[k] = sub(v)
	}
	for k, v := range s.Headers {
		s.Headers[k] = sub(v)
	}
}

// check is what is wrong with an entry, or "".
func (s Server) check() string {
	switch {
	case strings.TrimSpace(s.ID) == "":
		return "has no id"
	case (s.Command == "") == (s.URL == ""):
		return `must have exactly one of "command" (a program) or "url" (HTTP)`
	case s.URL != "" && !strings.HasPrefix(s.URL, "https://") && !strings.HasPrefix(s.URL, "http://localhost") && !strings.HasPrefix(s.URL, "http://127.0.0.1"):
		return "url must use https (http only on localhost)"
	}
	return ""
}

// Key identifies a server's declaration: a changed command, URL or setting is a different server,
// whose cached tool list no longer holds.
func (s Server) Key() string {
	data, _ := json.Marshal(s)
	return string(data)
}
