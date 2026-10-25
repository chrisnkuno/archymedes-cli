package advise

import (
	"context"
	"fmt"
	"strings"
	"time"
)

const (
	// MaxOptions is how many completions one request being typed is judged against.
	MaxOptions = 24 // the interface's maxJudged
	// PickTimeout bounds the judgment while someone types: later than this, they have typed on.
	PickTimeout = 3 * time.Second
)

// Pick asks Jev which option the person typing input is heading for: one choice among the options
// and "none". It returns each option's probability in order, and none's. The interface finds the
// options (commands, earlier requests, next steps, files); Jev only weighs them.
func Pick(ctx context.Context, j *Jev, input string, options []string) (scores []float64, none float64, err error) {
	input = strings.TrimSpace(input)
	if j == nil || input == "" || len(options) == 0 {
		return nil, 0, fmt.Errorf("nothing to judge")
	}
	options = options[:min(len(options), MaxOptions)]
	criteria := map[string]string{"none": "None of these: the developer is writing something else"}
	for i, o := range options {
		criteria[fmt.Sprintf("o%d", i)] = clip(o, 200)
	}
	question := Question{Type: "choice", Criteria: criteria,
		Instructions: "A developer is typing a request to a coding agent; `typed` is what they have written so far. Which option is what they are writing toward, or would most help them send?"}
	answers, err := j.Ask(ctx, PickTimeout, map[string]any{"typed": clip(input, 1000)}, map[string]Question{"intent": question})
	if err != nil {
		return nil, 0, err
	}
	p := answers["intent"].Probabilities
	scores = make([]float64, len(options))
	for i := range options {
		scores[i] = p[fmt.Sprintf("o%d", i)]
	}
	return scores, p["none"], nil
}
