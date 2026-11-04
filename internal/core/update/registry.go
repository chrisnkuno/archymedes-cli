package update

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// semverRE is a whole version, nothing before or after it: the string goes straight into an install
// command, so a prefix check is not enough.
var semverRE = regexp.MustCompile(`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`)

// secureRegistry reports whether a registry may be trusted with an install decision: HTTPS, or plain
// HTTP only to this machine (a local mirror or a test server).
func secureRegistry(base string) bool {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	h := u.Hostname()
	return u.Scheme == "http" && (h == "localhost" || h == "127.0.0.1" || h == "::1")
}

// DefaultRegistry is where the latest version is read from unless an npm registry is configured.
const DefaultRegistry = "https://registry.npmjs.org"

// registryBase is the registry to ask: an explicit override, then npm's own setting, then the default.
func registryBase(get func(string) string) string {
	for _, key := range []string{"ARCHYMEDES_UPDATE_REGISTRY", "npm_config_registry"} {
		if v := strings.TrimSpace(get(key)); v != "" {
			return strings.TrimRight(v, "/")
		}
	}
	return DefaultRegistry
}

// FetchLatest asks the registry for the newest published version of pkg, under a timeout. It reads
// the dist-tags endpoint, which returns only the tags, not the whole packument, so the check stays
// cheap. A non-answer is an error the caller treats as "nothing learned", not a failure to report.
func FetchLatest(ctx context.Context, get func(string) string, pkg string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, FetchTimeout)
	defer cancel()
	// Scoped names carry a slash that must be encoded in the path (@scope%2fname).
	base := registryBase(get)
	if !secureRegistry(base) {
		return "", fmt.Errorf("registry %q is not https", base)
	}
	endpoint := fmt.Sprintf("%s/-/package/%s/dist-tags", base, url.PathEscape(pkg))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("registry answered %s", resp.Status)
	}
	var tags struct {
		Latest string `json:"latest"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&tags); err != nil {
		return "", err
	}
	if _, ok := releaseParts(tags.Latest); !ok || !semverRE.MatchString(tags.Latest) {
		return "", fmt.Errorf("registry returned no usable latest version")
	}
	return tags.Latest, nil
}
