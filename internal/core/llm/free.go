package llm

import (
	"net/url"
	"regexp"
	"strings"
)

// Free models: which ids free mode may use, how big a model is from its id, how each measured as
// an agent, and how free mode is reached (ported from free-catalog.ts and free-model-profiles.ts,
// WS-50.4).

var freeModelID = regexp.MustCompile(`(?i)^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*:free$`)

// IsFreeModel is free mode's guard: the free router, or an exact `publisher/model:free` id.
func IsFreeModel(model string) bool {
	return model == FreeRouter || (len(model) <= 256 && freeModelID.MatchString(model))
}

// FreeGatewayURL is the official hosted free gateway, empty until it is deployed;
// ARCHYMEDES_FREE_GATEWAY_URL points at another.
const FreeGatewayURL = ""

// FreeAccess is how free mode reaches models: the person's own OpenRouter key, else a gateway
// that holds one. Both empty: free mode is not available.
func FreeAccess(env Env) (apiKey, gateway string) {
	if key := env.Get("OPENROUTER_API_KEY"); key != "" {
		return key, ""
	}
	if configured := env.Get("ARCHYMEDES_FREE_GATEWAY_URL"); configured != "" {
		return "", gatewayURL(configured)
	}
	return "", gatewayURL(FreeGatewayURL)
}

// gatewayURL accepts https, or http on this machine only, with no credentials in it.
func gatewayURL(value string) string {
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || u.Host == "" {
		return ""
	}
	host := u.Hostname()
	local := host == "localhost" || host == "127.0.0.1" || host == "::1"
	if u.User != nil || !(u.Scheme == "https" || (u.Scheme == "http" && local)) {
		return ""
	}
	if u.Path == "" {
		u.Path = "/"
	}
	return strings.TrimRight(u.String(), "/")
}
