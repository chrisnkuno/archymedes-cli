package tui

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/project"
)

// The project from the phone: folders, files read in chunks, search, what changed and its diffs,
// the log and an overview (internal/project/browse.go). Disk and git work run off the update loop;
// each answer comes back as an ack with data. Text files are read whole and their keys hidden
// before they are cut into chunks, so a key is never split across two and missed.

// linkChunk is the most of a file one message carries: its base64 fits phone.MaxMessage.
const linkChunk = 150_000

// linkResultMsg is a request's answer, made off the update loop.
type linkResultMsg struct {
	gen  int
	id   string
	ok   bool
	text string
	data any
}

// linkProject answers a request about the project, or returns nil when r is not one.
func (m *Model) linkProject(r linkRequest) tea.Cmd {
	root, gen, secrets := m.projectRoot(), m.link.gen, m.link.secrets
	answer := func(work func(ctx context.Context) (any, error)) tea.Cmd {
		return func() tea.Msg {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			data, err := work(ctx)
			if err != nil {
				return linkResultMsg{gen: gen, id: r.ID, text: err.Error()}
			}
			return linkResultMsg{gen: gen, id: r.ID, ok: true, data: data}
		}
	}
	switch r.Type {
	case "files":
		return answer(func(ctx context.Context) (any, error) {
			entries, err := project.List(ctx, root, r.Path)
			return map[string]any{"path": strings.Trim(r.Path, "/"), "entries": entries}, err
		})
	case "file":
		return answer(func(context.Context) (any, error) { return readForPhone(root, r.Path, r.Offset, secrets) })
	case "search":
		return answer(func(ctx context.Context) (any, error) {
			hits, truncated := project.Search(ctx, root, r.Query, 200)
			for i := range hits {
				hits[i].Text = hide(hits[i].Text, secrets)
			}
			if hits == nil {
				hits = []project.Hit{}
			}
			return map[string]any{"query": r.Query, "hits": hits, "truncated": truncated}, nil
		})
	case "changes":
		return answer(func(ctx context.Context) (any, error) {
			changes, err := project.Changes(ctx, root)
			out := []map[string]any{}
			for _, c := range changes {
				out = append(out, map[string]any{"path": c.Path, "from": c.From, "status": c.Status, "added": c.Added, "removed": c.Removed, "binary": c.Binary})
			}
			return map[string]any{"changes": out}, err
		})
	case "diff":
		return answer(func(ctx context.Context) (any, error) {
			// Only a path git lists as changed is diffed: inside the project by construction, and a
			// deleted file, gone from disk, still has its diff.
			changes, err := project.Changes(ctx, root)
			if err != nil {
				return nil, err
			}
			for _, c := range changes {
				if c.Path == r.Path {
					if project.Secret(c.Path) {
						return nil, errors.New("a file of keys or passwords stays on the computer")
					}
					diff, truncated, err := project.Diff(ctx, root, c)
					return map[string]any{"path": c.Path, "diff": hide(diff, secrets), "truncated": truncated}, err
				}
			}
			return nil, errors.New("no change to " + r.Path)
		})
	case "overview":
		return answer(func(ctx context.Context) (any, error) { return project.Overview(ctx, root) })
	case "log":
		return answer(func(ctx context.Context) (any, error) {
			commits, err := project.Log(ctx, root, 50)
			return map[string]any{"commits": commits}, err
		})
	}
	return nil
}

// readForPhone is one chunk of a file for the phone. A text file is read whole and its keys hidden
// first; the chunk is cut from that.
func readForPhone(root, rel string, offset int64, secrets []string) (any, error) {
	head, err := project.ReadChunk(root, rel, 0, 1)
	if err != nil {
		return nil, err
	}
	if !head.Text {
		c, err := project.ReadChunk(root, rel, offset, linkChunk)
		if err != nil {
			return nil, err
		}
		return chunkData(c.Path, c.Mime, false, c.Size, offset, c.Data), nil
	}
	whole, err := project.ReadChunk(root, rel, 0, project.MaxView)
	if err != nil {
		return nil, err
	}
	text := []byte(hide(string(whole.Data), secrets))
	size := int64(len(text))
	if offset < 0 || offset > size || (offset == size && size > 0) {
		return nil, errors.New("past the end of the file")
	}
	end := min(offset+linkChunk, size)
	return chunkData(whole.Path, whole.Mime, true, size, offset, text[offset:end]), nil
}

func chunkData(path, mime string, text bool, size, offset int64, data []byte) map[string]any {
	return map[string]any{"path": path, "mime": mime, "text": text, "size": size, "offset": offset,
		"data": data, "more": offset+int64(len(data)) < size, "language": project.Language(path)}
}

// hide replaces every known secret in s.
func hide(s string, secrets []string) string {
	for _, secret := range secrets {
		s = strings.ReplaceAll(s, secret, "[hidden]")
	}
	return s
}

// linkResult sends a request's answer to the phone.
func (m *Model) linkResult(msg linkResultMsg) {
	if m.link == nil || msg.gen != m.link.gen {
		return
	}
	raw, err := json.Marshal(map[string]any{"type": "ack", "of": msg.id, "ok": msg.ok, "text": msg.text, "data": msg.data})
	if err != nil {
		raw, _ = json.Marshal(map[string]any{"type": "ack", "of": msg.id, "ok": false, "text": err.Error()})
	}
	m.linkSend(raw)
}
