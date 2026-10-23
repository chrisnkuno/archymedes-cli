package policy

import (
	"regexp"
	"strings"
)

// The rules in this package were written as JavaScript regular expressions. Go's regexp (RE2) reads
// most of them the same way, with two differences that matter for a safety screen:
//
//   - JavaScript's `\s` also matches \v, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F,
//     U+205F, U+3000 and U+FEFF; RE2's matches only ASCII space, \t, \n, \f and \r.
//   - JavaScript's `.` refuses \n, \r, U+2028 and U+2029; RE2's refuses only \n.
//
// jsRegexp rewrites `\s`, `\S` and `.` into explicit classes with JavaScript's meaning, so a pattern
// copied from the TypeScript source can be compiled unchanged. Lookarounds have no RE2 equivalent
// and are rewritten as code where they appear (see safety.go, readonly.go, verification.go).

// jsSpaceClass is the body of a character class matching what JavaScript's `\s` matches.
const jsSpaceClass = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// jsDot is JavaScript's `.` without the s flag.
const jsDot = `[^\n\r\x{2028}\x{2029}]`

// jsRegexp compiles a JavaScript regular expression source with JavaScript's `\s` and `.`.
// ignoreCase is the `i` flag.
func jsRegexp(pattern string, ignoreCase bool) *regexp.Regexp {
	var b strings.Builder
	if ignoreCase {
		b.WriteString("(?i)")
	}
	inClass := false
	for i := 0; i < len(pattern); i++ {
		c := pattern[i]
		if c == '\\' && i+1 < len(pattern) {
			next := pattern[i+1]
			i++
			switch next {
			case 's':
				if inClass {
					b.WriteString(jsSpaceClass)
				} else {
					b.WriteString("[" + jsSpaceClass + "]")
				}
			case 'S':
				if inClass {
					panic("policy: \\S inside a character class is not supported: " + pattern)
				}
				b.WriteString("[^" + jsSpaceClass + "]")
			default:
				b.WriteByte(c)
				b.WriteByte(next)
			}
			continue
		}
		if inClass {
			if c == ']' {
				inClass = false
			}
			b.WriteByte(c)
			continue
		}
		switch c {
		case '[':
			inClass = true
			b.WriteByte(c)
			// A leading `^` or `]` is part of the class, not its end.
			if i+1 < len(pattern) && pattern[i+1] == '^' {
				b.WriteByte('^')
				i++
			}
		case '.':
			b.WriteString(jsDot)
		default:
			b.WriteByte(c)
		}
	}
	return regexp.MustCompile(b.String())
}

// isJSSpace reports whether r is whitespace to JavaScript's `\s` and String.prototype.trim.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// jsTrim is String.prototype.trim.
func jsTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// jsFields is `s.trim().split(/\s+/)` for a non-empty trimmed s; empty input gives no fields.
func jsFields(s string) []string { return strings.FieldsFunc(s, isJSSpace) }

// utf16Len is a JavaScript string's length.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xffff {
			n++
		}
	}
	return n
}

// replaceWhereFollowed is `s.replace(/(^|\s)…(?=\s|$)/g, "$1")`: re must start with a capture group
// that is kept, and a match counts only when the character after it is JavaScript whitespace or the
// end of s. Matches that fail the lookahead are left in place; for the patterns used here (which end
// in a fixed literal) no other match can begin inside one, so scanning on after it is what the
// JavaScript engine does too.
func replaceWhereFollowed(re *regexp.Regexp, s string) string {
	var b strings.Builder
	last := 0
	for _, m := range re.FindAllStringSubmatchIndex(s, -1) {
		end := m[1]
		if end < len(s) {
			r := []rune(s[end:])[0]
			if !isJSSpace(r) {
				continue
			}
		}
		b.WriteString(s[last:m[0]])
		b.WriteString(s[m[2]:m[3]])
		last = end
	}
	b.WriteString(s[last:])
	return b.String()
}
