package policy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// The action digest, byte for byte as core/cli/permissions.ts computes it, so a standing decision a
// TypeScript session persisted is found again by the Go ledger and the other way round:
//
//	sha256(JSON.stringify(canonicalize({policyVersion, tool, capabilityId, effect, provenance, arguments})))
//
// canonicalize sorts object keys with String.prototype.localeCompare, and JSON.stringify writes
// integer-like keys first in numeric order (a property of JavaScript objects), numbers in
// JavaScript's shortest form, and escapes only quotes, backslashes and control characters. All of
// that is reproduced here; see jsKeyLess for the one approximation.

// ApprovalPolicyVersion versions every persisted authorization key.
const ApprovalPolicyVersion = "archymedes-approval-v2"

// ActionDigest is the hex sha256 of the exact proposed action. Stable across object key order;
// changes when any argument, the tool, its capability, its declared effect or its provenance does.
// "" only when the arguments hold a value JSON cannot carry (a non-finite number, a function).
func ActionDigest(call tool.Call, t *tool.Tool) string {
	digest, _ := actionDigest(call, t)
	return digest
}

func actionDigest(call tool.Call, t *tool.Tool) (string, error) {
	provenance := map[string]any{"kind": "built-in"}
	if t.Provenance.Kind != "" {
		provenance = map[string]any{"kind": t.Provenance.Kind}
		if t.Provenance.ProviderID != "" {
			provenance["providerId"] = t.Provenance.ProviderID
		}
	}
	var args any = map[string]any{}
	if call.Args != nil {
		args = call.Args
	}
	var b strings.Builder
	err := writeCanonical(&b, map[string]any{
		"policyVersion": ApprovalPolicyVersion,
		"tool":          t.Name,
		"capabilityId":  t.Capability,
		"effect":        string(t.Effect),
		"provenance":    provenance,
		"arguments":     args,
	})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:]), nil
}

// ScopeKey is the versioned authorization key allow_always and deny_always persist.
func ScopeKey(call tool.Call, t *tool.Tool) string {
	return ApprovalPolicyVersion + ":" + ActionDigest(call, t)
}

func writeCanonical(b *strings.Builder, value any) error {
	switch v := value.(type) {
	case nil:
		b.WriteString("null")
	case string:
		writeJSString(b, v)
	case bool:
		b.WriteString(strconv.FormatBool(v))
	case float64:
		return writeJSNumber(b, v)
	case float32:
		return writeJSNumber(b, float64(v))
	case int:
		return writeJSNumber(b, float64(v))
	case int64:
		return writeJSNumber(b, float64(v))
	case int32:
		return writeJSNumber(b, float64(v))
	case uint:
		return writeJSNumber(b, float64(v))
	case uint64:
		return writeJSNumber(b, float64(v))
	case json.Number:
		f, err := v.Float64()
		if err != nil {
			return fmt.Errorf("approval arguments contain an invalid number %q", v)
		}
		return writeJSNumber(b, f)
	case []any:
		return writeArray(b, len(v), func(i int) any { return v[i] })
	case map[string]any:
		return writeObject(b, v)
	default:
		rv := reflect.ValueOf(value)
		switch rv.Kind() {
		case reflect.Slice, reflect.Array:
			if rv.Kind() == reflect.Slice && rv.IsNil() {
				b.WriteString("null")
				return nil
			}
			return writeArray(b, rv.Len(), func(i int) any { return rv.Index(i).Interface() })
		case reflect.Map:
			if rv.Type().Key().Kind() != reflect.String {
				return fmt.Errorf("approval arguments contain a map with non-string keys")
			}
			if rv.IsNil() {
				b.WriteString("null")
				return nil
			}
			m := make(map[string]any, rv.Len())
			for _, key := range rv.MapKeys() {
				m[key.String()] = rv.MapIndex(key).Interface()
			}
			return writeObject(b, m)
		case reflect.Pointer, reflect.Interface:
			if rv.IsNil() {
				b.WriteString("null")
				return nil
			}
			return writeCanonical(b, rv.Elem().Interface())
		case reflect.String:
			writeJSString(b, rv.String())
			return nil
		case reflect.Bool:
			b.WriteString(strconv.FormatBool(rv.Bool()))
			return nil
		case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
			return writeJSNumber(b, float64(rv.Int()))
		case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
			return writeJSNumber(b, float64(rv.Uint()))
		case reflect.Float32, reflect.Float64:
			return writeJSNumber(b, rv.Float())
		}
		return fmt.Errorf("approval arguments contain unsupported %T value", value)
	}
	return nil
}

func writeArray(b *strings.Builder, n int, at func(int) any) error {
	b.WriteByte('[')
	for i := 0; i < n; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		if err := writeCanonical(b, at(i)); err != nil {
			return err
		}
	}
	b.WriteByte(']')
	return nil
}

func writeObject(b *strings.Builder, m map[string]any) error {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.SliceStable(keys, func(i, j int) bool { return objectKeyLess(keys[i], keys[j]) })
	b.WriteByte('{')
	for i, key := range keys {
		if i > 0 {
			b.WriteByte(',')
		}
		writeJSString(b, key)
		b.WriteByte(':')
		if err := writeCanonical(b, m[key]); err != nil {
			return err
		}
	}
	b.WriteByte('}')
	return nil
}

// arrayIndex reports a key JavaScript treats as an array index (enumerated first, ascending).
func arrayIndex(key string) (uint64, bool) {
	if key == "" || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	for i := 0; i < len(key); i++ {
		if key[i] < '0' || key[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseUint(key, 10, 64)
	if err != nil || n > 4294967294 {
		return 0, false
	}
	return n, true
}

func objectKeyLess(a, b string) bool {
	ai, aIndex := arrayIndex(a)
	bi, bIndex := arrayIndex(b)
	switch {
	case aIndex && bIndex:
		return ai < bi
	case aIndex:
		return true
	case bIndex:
		return false
	}
	return jsKeyLess(a, b)
}

// asciiCollation is the order localeCompare (ICU root collation) gives the printable ASCII
// characters, case folded: punctuation and symbols, then digits, then letters.
const asciiCollation = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz"

var primaryWeight = func() [128]int {
	var w [128]int
	for i, c := range asciiCollation {
		w[c] = i + 1
		if c >= 'a' && c <= 'z' {
			w[c-'a'+'A'] = i + 1
		}
	}
	return w
}()

// jsKeyLess is `a.localeCompare(b) < 0` for the keys tool arguments have. ICU compares the whole
// string by primary weight (letters without case) first, then by case, lowercase first. That is
// exact for printable ASCII. Control characters are ignorable to ICU and skipped here; other
// characters are weighed after every ASCII one by code point, an approximation of ICU's tables
// that only matters for non-ASCII argument names. Remaining ties fall back to byte order.
func jsKeyLess(a, b string) bool {
	pa, ta := collationKeys(a)
	pb, tb := collationKeys(b)
	if c := compareInts(pa, pb); c != 0 {
		return c < 0
	}
	if c := compareInts(ta, tb); c != 0 {
		return c < 0
	}
	return a < b
}

func collationKeys(s string) (primary, tertiary []int) {
	for _, r := range s {
		switch {
		case r < 128 && primaryWeight[r] > 0:
			primary = append(primary, primaryWeight[r])
			if r >= 'A' && r <= 'Z' {
				tertiary = append(tertiary, 1)
			} else {
				tertiary = append(tertiary, 0)
			}
		case r < 128:
			// A control character: ignorable.
		default:
			primary = append(primary, 1000+int(r))
			tertiary = append(tertiary, 0)
		}
	}
	return primary, tertiary
}

func compareInts(a, b []int) int {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	return len(a) - len(b)
}

// writeJSNumber writes a number as JSON.stringify does; a non-finite one is refused, as in TS.
func writeJSNumber(b *strings.Builder, f float64) error {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return fmt.Errorf("approval arguments contain a non-finite number")
	}
	b.WriteString(jsNumberString(f))
	return nil
}

// jsNumberString is JavaScript's Number#toString for a finite number.
func jsNumberString(f float64) string {
	switch {
	case f != f:
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0" // -0 too
	}
	abs := math.Abs(f)
	if abs >= 1e-6 && abs < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	s := strconv.FormatFloat(f, 'e', -1, 64) // 1e-07, 1e+21
	mantissa, exponent, _ := strings.Cut(s, "e")
	sign := exponent[0]
	digits := strings.TrimLeft(exponent[1:], "0")
	if digits == "" {
		digits = "0"
	}
	return mantissa + "e" + string(sign) + digits
}

// writeJSString writes a string as JSON.stringify does: only `"`, `\` and control characters are
// escaped (U+2028, `<`, `>` and `&` are written as they are, unlike encoding/json).
func writeJSString(b *strings.Builder, s string) {
	const hexDigits = "0123456789abcdef"
	b.WriteByte('"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if c < 0x20 {
				b.WriteString(`\u00`)
				b.WriteByte(hexDigits[c>>4])
				b.WriteByte(hexDigits[c&0xf])
			} else {
				b.WriteByte(c)
			}
		}
	}
	b.WriteByte('"')
}
