package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/config"
	"github.com/chrisnkuno/friday-cli/internal/core/llm"
	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/server"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
	"github.com/chrisnkuno/friday-cli/internal/tui"
)

// The Go engine runs inside this binary and is the default. The interface reaches it through a
// pair of pipes and the same ACP client it uses for the TypeScript agent; `friday acp` serves it
// on stdio for an editor. What it does not implement yet goes to the TypeScript agent, started on
// first need. A session that needs something only the TypeScript engine has runs there instead,
// on its own, so nobody has to know which engine to ask for.

// engineChoice is which engine runs this invocation, and why when it is not the default.
type engineChoice struct {
	goEngine bool
	explicit bool
	why      string
}

// engineFacts are what the choice depends on, gathered by the caller so the rule stays pure.
type engineFacts struct {
	explicit    string               // --engine, else ARCHYMEDES_ENGINE, else the Engine setting
	args        []string             // the session flags after `acp`
	cwd         string               // the project
	resume      string               // --resume's id, "latest" or ""
	env         llm.Env              // settings.json under the environment
	tsAvailable bool                 // the TypeScript agent was found
	tsSession   func(id string) bool // a session with this id was written by the TypeScript engine
	goSession   func(id string) bool // a session with this id was written by the Go engine
}

// outsideEngines are providers that are someone's own installed agent and that only the TypeScript
// engine drives. Claude Code is not one of them: the Go engine drives it itself (internal/core/claude).
var outsideEngines = map[string]string{"codex": "Codex"}

// chooseEngine applies the rule: an explicit choice wins; otherwise the Go engine, unless this
// session needs what only the TypeScript engine has (and that engine is installed).
func chooseEngine(f engineFacts) (engineChoice, error) {
	switch strings.ToLower(strings.TrimSpace(f.explicit)) {
	case "go":
		return engineChoice{goEngine: true, explicit: true}, nil
	case "ts", "typescript":
		return engineChoice{explicit: true}, nil
	case "", "auto":
	default:
		return engineChoice{}, fmt.Errorf("engine %q: use go or ts", f.explicit)
	}
	if !f.tsAvailable {
		return engineChoice{goEngine: true}, nil
	}
	ts := func(why string) (engineChoice, error) { return engineChoice{why: why}, nil }
	opts, err := engineOptions(f.args, f.cwd)
	if err != nil {
		return ts(err.Error())
	}
	if id := f.resume; id != "" && id != "latest" && !f.goSession(id) && f.tsSession(id) {
		return ts("session " + id + " was written by the TypeScript engine")
	}
	provider := firstNonEmpty(opts.Provider, f.env.Get("ARCHYMEDES_PROVIDER"))
	if name, ok := outsideEngines[strings.ToLower(provider)]; ok {
		return ts(name + " runs on the TypeScript engine")
	}
	if _, err := llm.Resolve(f.env, opts.Provider, opts.Model); err != nil {
		switch {
		case strings.Contains(err.Error(), "not available in the Go engine"):
			return ts(err.Error())
		case f.env.Get("ARCHYMEDES_FREE_GATEWAY_URL") != "" && f.env.Get("OPENROUTER_API_KEY") == "":
			return ts("keyless free mode (a free gateway) runs on the TypeScript engine")
		}
	}
	return engineChoice{goEngine: true}, nil
}

// engineFactsFor gathers the facts for this invocation.
func engineFactsFor(flag string, args []string, cwd, resume string, tsAvailable bool) engineFacts {
	configDir := config.Default()
	return engineFacts{
		explicit: firstNonEmpty(flag, os.Getenv("ARCHYMEDES_ENGINE"), config.Setting(configDir, "ARCHYMEDES_ENGINE")),
		args:     args, cwd: cwd, resume: resume,
		env:         llm.LoadEnv(configDir, os.Environ()),
		tsAvailable: tsAvailable,
		tsSession: func(id string) bool {
			_, err := os.Stat(filepath.Join(cwd, ".archymedes", "sessions", id+".json"))
			return err == nil
		},
		goSession: func(id string) bool {
			_, err := os.Stat(filepath.Join(thread.Directory(cwd), id, "session.json"))
			return err == nil
		},
	}
}

// engineOptions reads the session flags the Go engine honours and refuses the ones it would ignore:
// a run in a Docker sandbox must never quietly run on the host instead.
func engineOptions(args []string, cwd string) (server.Options, error) {
	opts := server.Options{Cwd: cwd, ConfigDir: config.Default(), Environ: os.Environ(), Version: version}
	for i := 0; i < len(args); i++ {
		name, value, hasValue := strings.Cut(args[i], "=")
		next := func() string {
			if hasValue {
				return value
			}
			if i+1 < len(args) {
				i++
				return args[i]
			}
			return ""
		}
		switch name {
		case "--plan", "-p":
			opts.Mode = policy.Plan
		case "--build":
			opts.Mode = policy.Build
		case "--auto", "-y":
			opts.Mode = policy.Auto
		case "--defender":
			opts.Mode = policy.Defender
		case "--provider":
			opts.Provider = next()
		case "--model":
			opts.Model = next()
		case "--free":
			opts.Provider = "free"
		case "--cwd":
			opts.Cwd = next()
		case "--sandbox":
			if i+1 < len(args) && args[i+1] != "local" {
				return opts, fmt.Errorf("the Go engine runs on this computer only; --sandbox %s needs the TypeScript engine (--engine ts)", args[i+1])
			}
			if i+1 < len(args) {
				i++
			}
		case "--language", "--lang", "--location", "--country", "--currency", "--layout":
			// How things are shown, which the interface owns: nothing for the engine to do.
			next()
		case "--resume", "acp", "--acp":
			// --resume becomes session/load; acp is the mode itself.
		default:
			if strings.HasPrefix(name, "-") {
				return opts, fmt.Errorf("%s is not supported by the Go engine yet; --engine ts uses it", name)
			}
		}
	}
	return opts, nil
}

// lazyAgent starts the TypeScript agent the first time a method needs it, and keeps it.
type lazyAgent struct {
	argv []string
	cwd  string

	mu     sync.Mutex
	client *acp.Client
	err    error
}

func (l *lazyAgent) forward(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
	l.mu.Lock()
	if l.client == nil && l.err == nil {
		if len(l.argv) == 0 {
			l.err = errors.New("the TypeScript agent is not available to answer this")
		} else {
			l.client, l.err = acp.Start(ctx, append(append([]string(nil), l.argv...), "acp"), l.cwd, os.Environ())
			if l.client != nil {
				go func() {
					for range l.client.Messages() {
						// The forwarded methods have no events; drain so the client never blocks.
					}
				}()
			}
		}
	}
	client, err := l.client, l.err
	l.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return client.CallRaw(ctx, method, params)
}

func (l *lazyAgent) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.client != nil {
		l.client.Close()
	}
}

// startGoEngine runs the engine in this process and connects the interface's client to it.
func startGoEngine(opts server.Options, ts *lazyAgent) func(ctx context.Context) (tui.Agent, error) {
	return func(ctx context.Context) (tui.Agent, error) {
		toEngine, fromClient := io.Pipe()
		toClient, fromEngine := io.Pipe()
		if ts != nil {
			opts.Forward = ts.forward
		}
		srv := server.New(fromEngine, opts)
		go func() {
			_ = srv.Serve(context.Background(), toEngine)
			_ = fromEngine.Close() // the client sees the end of the stream and reports the engine stopped
			if ts != nil {
				ts.close()
			}
		}()
		return acp.Connect(ctx, fromClient, toClient)
	}
}

// serveGoEngine is `friday acp`: the engine on stdio, for an editor.
func serveGoEngine(opts server.Options, ts *lazyAgent) int {
	opts.Forward = ts.forward
	defer ts.close()
	if err := server.New(os.Stdout, opts).Serve(context.Background(), os.Stdin); err != nil {
		fmt.Fprintln(os.Stderr, "friday:", err)
		return 1
	}
	return 0
}
