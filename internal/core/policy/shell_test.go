package policy

import (
	"slices"
	"testing"
)

func TestTokenizeCommand(t *testing.T) {
	cases := []struct {
		command, goos string
		want          []string
	}{
		{`node -e "console.log(123)"`, "linux", []string{"node", "-e", "console.log(123)"}},
		{`node C:\Users\Friday\project\script.js "C:\Program Files\Friday\config.json"`, "windows",
			[]string{"node", `C:\Users\Friday\project\script.js`, `C:\Program Files\Friday\config.json`}},
		{`node C:\Users\x.js`, "win32", []string{"node", `C:\Users\x.js`}},
		{`echo a\ b 'c d' "e\"f" "g\h"`, "linux", []string{"echo", "a b", "c d", `e"f`, `g\h`}},
		{"echo a\\\nb", "linux", []string{"echo", "ab"}},
		{`echo ''`, "linux", []string{"echo", ""}},
		{`echo x\`, "linux", []string{"echo", `x\`}},
	}
	for _, c := range cases {
		got, err := TokenizeCommand(c.command, c.goos)
		if err != nil || !slices.Equal(got, c.want) {
			t.Errorf("TokenizeCommand(%q, %s) = %q, %v; want %q", c.command, c.goos, got, err, c.want)
		}
	}
	if _, err := TokenizeCommand("cat 'unbalanced", "linux"); err == nil || err.Error() != "unbalanced quote in command" {
		t.Errorf("unbalanced: %v", err)
	}
	if _, err := TokenizeCommand("   ", "linux"); err == nil || err.Error() != "command is empty" {
		t.Errorf("empty: %v", err)
	}
}

func TestRecursiveForceRemoval(t *testing.T) {
	for _, command := range []string{
		"rm -rf /workspace", "rm -fr /workspace", "rm -Rf /workspace", "rm -r -f /workspace",
		"rm --recursive --force /workspace", "rm --force --recursive /workspace", "rm -r --force /workspace", "sudo rm -rf /workspace",
	} {
		if !IsRefusedCommand(command) || !IsRecursiveForceRemoval(command) {
			t.Errorf("%q not caught", command)
		}
	}
	for _, command := range []string{
		"git rm -rf old-directory", "git rm -r --force old-directory", "git rm --cached -rf build/",
		"rm one-file.txt", "rm -i confirm-first.txt", "rm -rf 'unbalanced",
	} {
		if IsRecursiveForceRemoval(command) {
			t.Errorf("%q flagged", command)
		}
	}
}

func TestFindDelete(t *testing.T) {
	for _, command := range []string{"find . -delete", "find /workspace -name '*' -delete", "sudo find / -delete"} {
		if !IsRefusedCommand(command) || !IsFindDelete(command) {
			t.Errorf("%q not caught", command)
		}
	}
	for _, command := range []string{"find . -name '*.log'", "find . -type f -print", "npm run find-and-report"} {
		if IsFindDelete(command) {
			t.Errorf("%q flagged", command)
		}
	}
}

func TestIsRefusedCommand(t *testing.T) {
	for command, want := range map[string]bool{
		"rm -rf /":                 true,
		"git reset --hard HEAD~3":  true,
		"git clean -fd":            true,
		"git checkout -- .":        true,
		"mkfs.ext4 /dev/sda1":      true, // "." is a word boundary
		"mkfs /dev/sda1":           true,
		"dd if=/dev/zero of=x":     true,
		"echo x > /dev/sda":        true,
		":(){ :|:& };:":            true,
		"rm build/output.txt":      false,
		"npm test":                 false,
		"git rm -rf old-directory": false,
		// Known, deliberate gaps (adversarial-policy.test.ts): if one now fails, the denylist grew.
		"truncate -s 0 /dev/sda":         false,
		"rsync -a --delete / /dev/null/": false,
		"shred -u important.txt":         false,
		"chmod -R 000 /":                 false,
	} {
		if got := IsRefusedCommand(command); got != want {
			t.Errorf("IsRefusedCommand(%q) = %v, want %v", command, got, want)
		}
	}
}
