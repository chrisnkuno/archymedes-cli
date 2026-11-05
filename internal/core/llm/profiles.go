package llm

import (
	"strconv"
	"strings"
)

// How big a free model is from its id, and how each measured as an agent (free-model-profiles.ts;
// WS-50.4). The fit orders the free router and is shown in the model picker; a pinned model is
// always honoured, whatever its fit.

// SmallModelBillions: a model at or under this many billion parameters is chat-sized.
const SmallModelBillions = 4

// ModelSizeBillions is the parameter count a model id names (`lfm-2.5-2.6b`, `gemma-270m`), in
// billions; ok is false when the id says nothing. The smallest named count wins.
func ModelSizeBillions(model string) (float64, bool) {
	id := strings.ToLower(model)
	best, found := 0.0, false
	for _, n := range sizes(id, 'b', true) {
		if !found || n < best {
			best, found = n, true
		}
	}
	if found {
		return best, true
	}
	if m := sizes(id, 'm', false); len(m) > 0 {
		return m[0] / 1000, true
	}
	return 0, false
}

// sizes are the numbers in id written as <digits>[.<digits>]<unit>, each after the start or a
// character other than a letter, digit or dot, and before anything but a letter.
func sizes(id string, unit byte, all bool) []float64 {
	letter := func(c byte) bool { return c >= 'a' && c <= 'z' }
	digit := func(c byte) bool { return c >= '0' && c <= '9' }
	var out []float64
	for i := 0; i < len(id); i++ {
		if !digit(id[i]) || (i > 0 && (letter(id[i-1]) || digit(id[i-1]) || id[i-1] == '.')) {
			continue
		}
		j := i
		for j < len(id) && digit(id[j]) {
			j++
		}
		ends := []int{j}
		if j+1 < len(id) && id[j] == '.' && digit(id[j+1]) {
			k := j + 1
			for k < len(id) && digit(id[k]) {
				k++
			}
			ends = []int{k, j}
		}
		for _, end := range ends {
			if end < len(id) && id[end] == unit && (end+1 == len(id) || !letter(id[end+1])) {
				n, _ := strconv.ParseFloat(id[i:end], 64)
				out = append(out, n)
				if !all {
					return out
				}
				i = end
				break
			}
		}
	}
	return out
}

// IsSmallModel is a chat-sized model by its id.
func IsSmallModel(model string) bool {
	size, ok := ModelSizeBillions(model)
	return ok && size <= SmallModelBillions
}

// FreeFit is how a free model measured as an agent: agent, busy, slow, apps-only, small or unmeasured.
type FreeFit struct {
	Fit  string `json:"fit"`
	Note string `json:"note"`
}

// FreeProfilesMeasured is when the profiles were measured (free-model-profiles.ts).
const FreeProfilesMeasured = "2026-10-16"

var freeProfiles = map[string]FreeFit{
	"nvidia/nemotron-3.5-super-vl:free":                  {"agent", "tool calls verified; finished the test task in 78s"},
	"dots-studio/dots-3-note-preview:free":               {"agent", "tool calls verified; finished the test task in 104s"},
	"nvidia/nemotron-3-super-120b-a12b:free":             {"agent", "tool calls verified; finished the test task in 140s"},
	"cohere/north-mini-code:free":                        {"agent", "tool calls verified; first token in about a second"},
	"poolside/laguna-s-2.1:free":                         {"busy", "tool calls verified; upstream rate-limits most requests"},
	"poolside/laguna-xs-2.1:free":                        {"busy", "tool calls verified; upstream rate-limits most requests"},
	"google/gemma-4-31b-it:free":                         {"busy", "upstream rate-limited 9 of 10 requests"},
	"google/gemma-4-26b-a4b-it:free":                     {"busy", "upstream rate-limited 9 of 10 requests"},
	"nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": {"busy", "tool calls verified; upstream capacity often exhausted"},
	"nvidia/nemotron-3.5-lightning:free":                 {"slow", "tool calls verified, but 15s-3min before the first token"},
	"nvidia/nemotron-3-ultra-550b-a55b:free":             {"slow", "every probe timed out upstream after 5 minutes"},
	"thinkingmachines/inkling:free":                      {"apps-only", "OpenRouter serves it only to apps it lists; refused (403) here"},
	"thinkingmachines/inkling-small:free":                {"apps-only", "OpenRouter serves it only to apps it lists; refused (403) here"},
	"liquid/lfm-2.5-2.6b:free":                           {"small", "2.6B: calls are well-formed, but 37 of 57 failed in the test task"},
}

// FreeProfile is the measured fit of a free model id, or what its id alone says.
func FreeProfile(id string) FreeFit {
	if p, ok := freeProfiles[id]; ok {
		return p
	}
	if IsSmallModel(id) {
		return FreeFit{"small", "chat-sized: fine for chat, but it often misuses tools"}
	}
	return FreeFit{"unmeasured", "tool calling not measured yet"}
}
