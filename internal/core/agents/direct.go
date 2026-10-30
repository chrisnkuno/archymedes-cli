package agents

import (
	"errors"
	"fmt"
	"strings"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/roles"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
)

// UserCallPrefix starts the call id of a sub-agent the person started themselves (/agent, alt+a).
// No tool call stands behind it, so the interface draws its card from its thread events instead.
const UserCallPrefix = "user:"

// StartAgent starts a background sub-agent the person asked for directly, outside any turn, so
// several can run at once while the conversation carries on. text is "[role] <brief>": a first
// word naming a role picks it. Without one, a writable helper ("general") where it can have a
// worktree of its own, else a read-only one ("explore"). Its report reaches the conversation the
// way any background sub-agent's does.
func (s *Session) StartAgent(text string) (thread.Thread, roles.Profile, error) {
	cannotWrite := ""
	switch {
	case s.Mode() == policy.Plan:
		cannotWrite = "plan mode changes nothing"
	case !s.inGitRepo():
		cannotWrite = "a writable helper you start yourself works in a git worktree of its own, and this folder is not a git repository with a commit"
	}
	profile, brief, err := s.HelperRole(text, cannotWrite == "", cannotWrite)
	if err != nil {
		return thread.Thread{}, roles.Profile{}, err
	}
	c, err := s.startChild(s.life, spawnSpec{profile: profile, brief: brief, fork: thread.ForkNone, background: true, callID: UserCallPrefix + thread.NewThreadID()})
	if err != nil {
		return thread.Thread{}, roles.Profile{}, err
	}
	return c.t, profile, nil
}

// HelperRole reads "[role] <brief>": the role a first word names, else general when helpers may
// write by default and explore when not, and the brief. A writable role is refused, saying
// cannotWrite, when one may not start here.
func (s *Session) HelperRole(text string, writeByDefault bool, cannotWrite string) (roles.Profile, string, error) {
	text = strings.TrimSpace(text)
	roleName := roles.DefaultReadOnlyRole
	if writeByDefault {
		roleName = roles.DefaultWritableRole
	}
	if first, rest, _ := strings.Cut(text, " "); rest != "" {
		if _, ok := s.profile(strings.ToLower(first)); ok {
			roleName, text = strings.ToLower(first), strings.TrimSpace(rest)
		}
	}
	if _, bare := s.profile(strings.ToLower(text)); text == "" || bare {
		return roles.Profile{}, "", errors.New("say what the helper should do: /agent [role] <task>, e.g. /agent explore map the API")
	}
	profile, ok := s.profile(roleName)
	if !ok {
		return roles.Profile{}, "", fmt.Errorf("no role %q; roles here: %s", roleName, strings.Join(s.roleNames(), ", "))
	}
	if !profile.ReadOnly && cannotWrite != "" {
		return roles.Profile{}, "", fmt.Errorf("%s, so a %s helper cannot start; pick a read-only role (%s)", cannotWrite, profile.Name, strings.Join(s.readOnlyNames(), ", "))
	}
	return profile, text, nil
}

func (s *Session) roleNames() []string {
	var out []string
	for _, p := range s.profiles {
		out = append(out, p.Name)
	}
	return out
}

func (s *Session) readOnlyNames() []string {
	var out []string
	for _, p := range s.rolesFor(true) {
		out = append(out, p.Name)
	}
	return out
}
