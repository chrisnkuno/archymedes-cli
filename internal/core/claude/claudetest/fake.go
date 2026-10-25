// Package claudetest is a stand-in for the `claude` program, speaking its stream-JSON protocol, so
// tests can drive a real process without Claude Code or the network. A test binary becomes it by
// calling Main from TestMain when Active says so, and points ARCHYMEDES_CLAUDE_PATH (or an
// Executable option) at itself.
//
// What it does follows the prompt: one containing "run" asks to run `rm -rf build` and reports what
// it was told; "wait" starts a command and waits to be interrupted; anything else answers "Hello!".
// Every start, prompt and control request is appended to the file named by FAKE_CLAUDE_LOG.
package claudetest

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
)

// Env marks a process as the fake.
const Env = "FRIDAY_FAKE_CLAUDE"

// Active reports whether this process was started as the fake.
func Active() bool { return os.Getenv(Env) == "1" }

// Main is the fake's whole life.
func Main() {
	log := func(format string, args ...any) {
		if file := os.Getenv("FAKE_CLAUDE_LOG"); file != "" {
			if f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
				fmt.Fprintf(f, format+"\n", args...)
				_ = f.Close()
			}
		}
	}
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "auth" {
		fmt.Printf(`{"loggedIn":%v,"authMethod":"claude.ai","subscriptionType":"max","email":"never-read@example.com"}`+"\n", os.Getenv("FAKE_CLAUDE_SIGNED_OUT") != "1")
		return
	}
	log("start %s", strings.Join(args, " "))
	for i, a := range args {
		if a == "--resume" && i+1 < len(args) && args[i+1] == "gone" {
			fmt.Fprintln(os.Stderr, "No conversation found with session ID: gone")
			os.Exit(1)
		}
	}
	var writeMu sync.Mutex
	write := func(v any) {
		line, _ := json.Marshal(v)
		writeMu.Lock()
		defer writeMu.Unlock()
		_, _ = os.Stdout.Write(append(line, '\n'))
	}
	answers := make(chan map[string]any, 1)
	interrupted := make(chan struct{}, 1)
	prompts := make(chan string, 8)
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 64<<10), 16<<20)
		for scanner.Scan() {
			var m map[string]any
			if json.Unmarshal(scanner.Bytes(), &m) != nil {
				continue
			}
			switch m["type"] {
			case "control_request":
				req, _ := m["request"].(map[string]any)
				log("control %s %s", req["subtype"], scanner.Text())
				reply := map[string]any{}
				switch req["subtype"] {
				case "initialize":
					reply = map[string]any{"models": []any{map[string]any{"value": "default"}, map[string]any{"value": "opus"}, map[string]any{"value": "haiku"}}}
				case "interrupt":
					interrupted <- struct{}{}
				case "rewind_files":
					reply = map[string]any{"canRewind": true, "filesChanged": []any{"a.go"}}
				}
				write(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": m["request_id"], "response": reply}})
			case "control_response":
				response, _ := m["response"].(map[string]any)
				answer, _ := response["response"].(map[string]any)
				answers <- answer
			case "user":
				message, _ := m["message"].(map[string]any)
				content, _ := message["content"].(string)
				log("prompt %s", strings.ReplaceAll(content, "\n", "\\n"))
				prompts <- content
			}
		}
		close(prompts)
	}()
	stream := func(event map[string]any) {
		write(map[string]any{"type": "stream_event", "event": event, "parent_tool_use_id": nil})
	}
	say := func(id, text string) {
		stream(map[string]any{"type": "message_start", "message": map[string]any{"id": id, "model": "claude-test", "usage": map[string]any{"input_tokens": 10, "cache_read_input_tokens": 90}}})
		stream(map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": text}})
		write(map[string]any{"type": "assistant", "message": map[string]any{"id": id, "content": []any{map[string]any{"type": "text", "text": text}}}, "parent_tool_use_id": nil})
		stream(map[string]any{"type": "message_delta", "usage": map[string]any{"output_tokens": 5}})
		stream(map[string]any{"type": "message_stop"})
	}
	useTool := func(id, command string) {
		stream(map[string]any{"type": "message_start", "message": map[string]any{"id": "m-" + id, "model": "claude-test"}})
		write(map[string]any{"type": "assistant", "message": map[string]any{"id": "m-" + id, "content": []any{map[string]any{"type": "tool_use", "id": id, "name": "Bash", "input": map[string]any{"command": command}}}}, "parent_tool_use_id": nil})
		stream(map[string]any{"type": "message_stop"})
	}
	toolResult := func(id, text string, isError bool) {
		write(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "tool_result", "tool_use_id": id, "content": text, "is_error": isError}}}, "parent_tool_use_id": nil})
	}
	result := func(subtype, text string) {
		write(map[string]any{"type": "result", "subtype": subtype, "is_error": subtype != "success", "result": text, "session_id": "claude-1", "total_cost_usd": 0.25, "num_turns": 1, "usage": map[string]any{}})
	}
	for prompt := range prompts {
		write(map[string]any{"type": "system", "subtype": "init", "session_id": "claude-1", "model": "claude-test", "tools": []any{"Bash", "Read"}})
		switch {
		case strings.Contains(prompt, "run"):
			useTool("t1", "rm -rf build")
			write(map[string]any{"type": "control_request", "request_id": "c1", "request": map[string]any{"subtype": "can_use_tool", "tool_name": "Bash", "input": map[string]any{"command": "rm -rf build"}, "tool_use_id": "t1", "permission_suggestions": []any{map[string]any{"type": "addRules", "destination": "localSettings"}}}})
			answer := <-answers
			log("answer %s", mustJSON(answer))
			if answer["behavior"] == "allow" {
				toolResult("t1", "removed", false)
			} else {
				toolResult("t1", fmt.Sprint(answer["message"]), true)
			}
			say("m2", "Done.")
			result("success", "Done.")
		case strings.Contains(prompt, "wait"):
			useTool("t2", "sleep 100")
			<-interrupted
			toolResult("t2", "Interrupted", true)
			result("error_during_execution", "")
		default:
			say("m1", "Hello!")
			result("success", "Hello!")
		}
	}
}

func mustJSON(v any) string {
	data, _ := json.Marshal(v)
	return string(data)
}
