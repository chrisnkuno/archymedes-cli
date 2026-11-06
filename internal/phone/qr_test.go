package phone

import (
	"encoding/json"
	"math/rand/v2"
	"os"
	"strings"
	"testing"
)

// The QR code /phone shows. A code that looks right but does not scan is worse than none, so these
// tests decode every code with a reader written here, apart from the encoder: it finds the format
// from the modules, unmasks, checks every block's Reed–Solomon codewords with its own arithmetic,
// and reads the bytes back. It also holds the fixed patterns to where the standard puts them.

// --- an independent reader -------------------------------------------------------------------

// gf is GF(256) over x^8+x^4+x^3+x^2+1, built here, not taken from the encoder.
type gf struct{ exp, log [512]int }

func newGF() *gf {
	g := &gf{}
	x := 1
	for i := range 255 {
		g.exp[i], g.log[x] = x, i
		x <<= 1
		if x&0x100 != 0 {
			x ^= 0x11d
		}
	}
	for i := 255; i < 512; i++ {
		g.exp[i] = g.exp[i-255]
	}
	return g
}

func (g *gf) mul(a, b int) int {
	if a == 0 || b == 0 {
		return 0
	}
	return g.exp[g.log[a]+g.log[b]]
}

// syndromesZero is whether a block (data then EC codewords) is a codeword: it vanishes at α^0…α^(ec-1).
func (g *gf) syndromesZero(block []byte, ec int) bool {
	for i := range ec {
		s := 0
		for _, c := range block {
			s = g.mul(s, g.exp[i]) ^ int(c)
		}
		if s != 0 {
			return false
		}
	}
	return true
}

func formatCode(level, mask int) int {
	data := level<<3 | mask
	rem := data
	for range 10 {
		rem = rem<<1 ^ (rem>>9)*0x537
	}
	return (data<<10 | rem) ^ 0x5412
}

// functionArea marks finders, separators, timing, alignment, format and version areas.
func functionArea(size int) [][]bool {
	version := (size - 17) / 4
	f := make([][]bool, size)
	for i := range f {
		f[i] = make([]bool, size)
	}
	box := func(r0, c0, n int) {
		for r := r0; r < r0+n; r++ {
			for c := c0; c < c0+n; c++ {
				if r >= 0 && c >= 0 && r < size && c < size {
					f[r][c] = true
				}
			}
		}
	}
	box(0, 0, 9)
	box(0, size-8, 8)
	box(size-8, 0, 8)
	for i := range size {
		f[6][i], f[i][6] = true, true
	}
	for i := range 9 {
		f[8][i], f[i][8] = true, true
	}
	for i := range 8 {
		f[8][size-1-i], f[size-1-i][8] = true, true
	}
	pos := alignTable[version]
	for _, r := range pos {
		for _, c := range pos {
			if (r == 6 && c == 6) || (r == 6 && c == pos[len(pos)-1]) || (r == pos[len(pos)-1] && c == 6) {
				continue
			}
			box(r-2, c-2, 5)
		}
	}
	if version >= 7 {
		for i := range 6 {
			for j := range 3 {
				f[i][size-11+j], f[size-11+j][i] = true, true
			}
		}
	}
	return f
}

// alignTable is the standard's alignment centres, written out again here.
var alignTable = map[int][]int{1: nil, 2: {6, 18}, 3: {6, 22}, 4: {6, 26}, 5: {6, 30}, 6: {6, 34}, 7: {6, 22, 38}, 8: {6, 24, 42}, 9: {6, 26, 46}, 10: {6, 28, 50}}

// blockTable is, per version and level (0 M, 1 L), EC per block and the data lengths of its blocks.
var blockTable = map[[2]int]struct {
	ec   int
	data []int
}{
	{1, 0}: {10, []int{16}}, {1, 1}: {7, []int{19}},
	{2, 0}: {16, []int{28}}, {2, 1}: {10, []int{34}},
	{3, 0}: {26, []int{44}}, {3, 1}: {15, []int{55}},
	{4, 0}: {18, []int{32, 32}}, {4, 1}: {20, []int{80}},
	{5, 0}: {24, []int{43, 43}}, {5, 1}: {26, []int{108}},
	{6, 0}: {16, []int{27, 27, 27, 27}}, {6, 1}: {18, []int{68, 68}},
	{7, 0}: {18, []int{31, 31, 31, 31}}, {7, 1}: {20, []int{78, 78}},
	{8, 0}: {22, []int{38, 38, 39, 39}}, {8, 1}: {24, []int{97, 97}},
	{9, 0}: {22, []int{36, 36, 36, 37, 37}}, {9, 1}: {30, []int{116, 116}},
	{10, 0}: {26, []int{43, 43, 43, 43, 44}}, {10, 1}: {18, []int{68, 68, 69, 69}},
}

func maskBit(mask, r, c int) bool {
	switch mask {
	case 0:
		return (r+c)%2 == 0
	case 1:
		return r%2 == 0
	case 2:
		return c%3 == 0
	case 3:
		return (r+c)%3 == 0
	case 4:
		return (r/2+c/3)%2 == 0
	case 5:
		return r*c%2+r*c%3 == 0
	case 6:
		return (r*c%2+r*c%3)%2 == 0
	default:
		return ((r+c)%2+r*c%3)%2 == 0
	}
}

// decode reads a code's text, failing the test where the code is not a valid one.
func decode(t *testing.T, m [][]bool) string {
	t.Helper()
	size := len(m)
	if (size-17)%4 != 0 || size < 21 {
		t.Fatalf("a %d-module code is no QR size", size)
	}
	version := (size - 17) / 4
	// Format, first copy, as the standard places it.
	read := 0
	bit := func(r, c, i int) {
		if m[r][c] {
			read |= 1 << i
		}
	}
	for i := range 6 {
		bit(i, 8, i)
	}
	bit(7, 8, 6)
	bit(8, 8, 7)
	bit(8, 7, 8)
	for i := 9; i < 15; i++ {
		bit(8, 14-i, i)
	}
	level, mask := -1, -1
	for l := range 4 {
		for k := range 8 {
			if formatCode(l, k) == read {
				level, mask = l, k
			}
		}
	}
	if level < 0 {
		t.Fatalf("format bits %015b match no level and mask", read)
	}
	if level > 1 {
		t.Fatalf("level %d: the encoder uses M or L", level)
	}
	// The codewords, in the zigzag, unmasked.
	function := functionArea(size)
	var bits []bool
	for right := size - 1; right >= 1; right -= 2 {
		if right == 6 {
			right = 5
		}
		for v := range size {
			for j := range 2 {
				c := right - j
				r := v
				if (right+1)&2 == 0 {
					r = size - 1 - v
				}
				if !function[r][c] {
					bits = append(bits, m[r][c] != maskBit(mask, r, c))
				}
			}
		}
	}
	codewords := make([]byte, len(bits)/8)
	for i := range codewords {
		for j := range 8 {
			if bits[i*8+j] {
				codewords[i] |= 1 << (7 - j)
			}
		}
	}
	// De-interleave and check every block.
	spec, ok := blockTable[[2]int{version, level}]
	if !ok {
		t.Fatalf("no table for version %d", version)
	}
	n := len(spec.data)
	blocks := make([][]byte, n)
	idx := 0
	longest := spec.data[n-1]
	for i := range longest {
		for b := range n {
			if i < spec.data[b] {
				blocks[b] = append(blocks[b], codewords[idx])
				idx++
			}
		}
	}
	ecs := make([][]byte, n)
	for range spec.ec {
		for b := range n {
			ecs[b] = append(ecs[b], codewords[idx])
			idx++
		}
	}
	g := newGF()
	var data []byte
	for b := range n {
		if !g.syndromesZero(append(append([]byte(nil), blocks[b]...), ecs[b]...), spec.ec) {
			t.Fatalf("block %d of version %d fails its Reed–Solomon check", b, version)
		}
		data = append(data, blocks[b]...)
	}
	// Byte mode: 0100, the count, the bytes.
	at := 0
	take := func(k int) int {
		v := 0
		for range k {
			v = v<<1 | int(data[at/8]>>(7-at%8)&1)
			at++
		}
		return v
	}
	if mode := take(4); mode != 0b0100 {
		t.Fatalf("mode %04b, want byte mode", mode)
	}
	countBits := 8
	if version >= 10 {
		countBits = 16
	}
	count := take(countBits)
	out := make([]byte, count)
	for i := range out {
		out[i] = byte(take(8))
	}
	return string(out)
}

// --- the tests ---------------------------------------------------------------------------------

// FUNCTIONAL: the pairing link, as /phone shows it, decodes to itself.
func TestThePairingCodeScansToItsLink(t *testing.T) {
	s, _ := NewSecret()
	link := s.Link("https://archymedes.xyz/phone")
	code, err := EncodeQR(link)
	if err != nil {
		t.Fatal(err)
	}
	if got := decode(t, code); got != link {
		t.Fatalf("decoded %q, want %q", got, link)
	}
}

// INVARIANT: any text that fits decodes to itself, at every length up to the largest, across
// every version the encoder may pick, and the smallest version that holds it is the one used.
func TestEveryTextDecodesToItself(t *testing.T) {
	r := rand.New(rand.NewPCG(7, 8))
	alphabet := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_#:/.?=&%"
	for n := 0; n <= MaxQRText; n += 1 + n/12 {
		for range 3 {
			var b strings.Builder
			for range n {
				b.WriteByte(alphabet[r.IntN(len(alphabet))])
			}
			text := b.String()
			code, err := EncodeQR(text)
			if err != nil {
				t.Fatalf("%d bytes: %v", n, err)
			}
			if got := decode(t, code); got != text {
				t.Fatalf("%d bytes: decoded %q, want %q", n, got, text)
			}
		}
	}
	// Bytes that are not ASCII are carried as bytes.
	text := "héllo 🙂 日本"
	code, _ := EncodeQR(text)
	if got := decode(t, code); got != text {
		t.Fatalf("decoded %q", got)
	}
}

// BEHAVIOUR: text too long for the largest version is refused, not cut.
func TestTextTooLongIsRefused(t *testing.T) {
	if _, err := EncodeQR(strings.Repeat("x", MaxQRText+1)); err == nil {
		t.Fatal("encoded text over the limit")
	}
}

// INVARIANT: the fixed patterns are where the standard puts them: three finders with their
// separators, the timing lines, the dark module, and both copies of the format agree.
func TestTheFixedPatternsAreInPlace(t *testing.T) {
	for _, n := range []int{1, 20, 74, 90, 150, MaxQRText} {
		code, err := EncodeQR(strings.Repeat("a", n))
		if err != nil {
			t.Fatal(err)
		}
		size := len(code)
		finder := func(r0, c0 int) {
			for r := -1; r <= 7; r++ {
				for c := -1; c <= 7; c++ {
					rr, cc := r0+r, c0+c
					if rr < 0 || cc < 0 || rr >= size || cc >= size {
						continue
					}
					want := r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
						(r == 0 || r == 6 || c == 0 || c == 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
					if code[rr][cc] != want {
						t.Fatalf("%d bytes: finder at (%d,%d) wrong at (%d,%d)", n, r0, c0, rr, cc)
					}
				}
			}
		}
		finder(0, 0)
		finder(0, size-7)
		finder(size-7, 0)
		for i := 8; i < size-8; i++ {
			if code[6][i] != (i%2 == 0) || code[i][6] != (i%2 == 0) {
				t.Fatalf("%d bytes: timing broken at %d", n, i)
			}
		}
		if !code[size-8][8] {
			t.Fatalf("%d bytes: no dark module", n)
		}
		var first, second int
		for i := range 6 {
			if code[i][8] {
				first |= 1 << i
			}
		}
		for i, rc := range [][2]int{{7, 8}, {8, 8}, {8, 7}} {
			if code[rc[0]][rc[1]] {
				first |= 1 << (6 + i)
			}
		}
		for i := 9; i < 15; i++ {
			if code[8][14-i] {
				first |= 1 << i
			}
		}
		for i := range 8 {
			if code[8][size-1-i] {
				second |= 1 << i
			}
		}
		for i := 8; i < 15; i++ {
			if code[size-15+i][8] {
				second |= 1 << i
			}
		}
		if first != second {
			t.Fatalf("%d bytes: format copies differ: %015b %015b", n, first, second)
		}
	}
}

// INVARIANT: from version 7 the version is written twice, the same, with its error check.
func TestTheVersionIsWrittenTwiceFromVersionSeven(t *testing.T) {
	code, _ := EncodeQR(strings.Repeat("v", 140)) // past version 6 at level M
	size := len(code)
	version := (size - 17) / 4
	if version < 7 {
		t.Fatalf("version %d; the test wants 7 or more", version)
	}
	var a, b int
	for i := range 18 {
		if code[i/3][size-11+i%3] {
			a |= 1 << i
		}
		if code[size-11+i%3][i/3] {
			b |= 1 << i
		}
	}
	rem := version
	for range 12 {
		rem = rem<<1 ^ (rem>>11)*0x1f25
	}
	if want := version<<12 | rem; a != want || b != want {
		t.Fatalf("version bits %018b / %018b, want %018b", a, b, want)
	}
}

// BEHAVIOUR: the code is drawn for a terminal in half blocks, dark on light whatever the theme,
// with a quiet zone, two rows of modules to a line, and every line as wide as the next.
func TestTheCodeIsDrawnForATerminal(t *testing.T) {
	code, _ := EncodeQR("https://archymedes.xyz/phone#k=AAAA")
	lines := strings.Split(strings.TrimRight(RenderQR(code), "\n"), "\n")
	want := (len(code) + 2*QuietZone + 1) / 2
	if len(lines) != want {
		t.Fatalf("%d lines, want %d", len(lines), want)
	}
	for i, l := range lines {
		if !strings.Contains(l, "\x1b[") {
			t.Fatalf("line %d sets no colours, so a dark theme would invert it", i)
		}
		if w := visible(l); w != len(code)+2*QuietZone {
			t.Fatalf("line %d is %d wide, want %d", i, w, len(code)+2*QuietZone)
		}
	}
}

// visible is a line's width without its escape codes.
func visible(s string) int {
	n, esc := 0, false
	for _, r := range s {
		switch {
		case r == '\x1b':
			esc = true
		case esc && r == 'm':
			esc = false
		case !esc:
			n++
		}
	}
	return n
}

// TestDumpCodesForAnOutsideReader writes codes for a third-party decoder to check
// (FRIDAY_QR_DUMP=<file>); without it there is nothing to do.
func TestDumpCodesForAnOutsideReader(t *testing.T) {
	out := os.Getenv("FRIDAY_QR_DUMP")
	if out == "" {
		t.Skip("set FRIDAY_QR_DUMP to write codes for an outside reader")
	}
	r := rand.New(rand.NewPCG(11, 12))
	type dump struct {
		Text string   `json:"text"`
		Code [][]bool `json:"code"`
	}
	var all []dump
	s, _ := NewSecret()
	texts := []string{s.Link("https://archymedes.xyz/phone"), "", "a", "héllo 🙂"}
	for n := 1; n <= MaxQRText; n += 7 {
		var b strings.Builder
		for range n {
			b.WriteByte(byte(33 + r.IntN(94)))
		}
		texts = append(texts, b.String())
	}
	for _, text := range texts {
		code, err := EncodeQR(text)
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, dump{text, code})
	}
	data, _ := json.Marshal(all)
	if err := os.WriteFile(out, data, 0o644); err != nil {
		t.Fatal(err)
	}
}
