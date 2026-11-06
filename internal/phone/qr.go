package phone

import (
	"errors"
	"strings"
)

// A QR code encoder for the pairing link: byte mode at error correction level M, versions 1 to
// 10, all eight masks tried and the one the standard's penalty rules like best kept. It is written
// here rather than taken as a dependency; qr_test.go decodes what it makes with a reader of its own.

// MaxQRText is the most bytes a code holds: version 10 at level M.
const MaxQRText = 213

// QuietZone is the light border, in modules, a reader needs around a code.
const QuietZone = 4

// qrVersion is one version's layout at level M: EC codewords per block, and each block's data
// codewords (short blocks first).
type qrVersion struct {
	ec    int
	data  []int
	align []int
}

var qrVersions = []qrVersion{
	1:  {10, []int{16}, nil},
	2:  {16, []int{28}, []int{6, 18}},
	3:  {26, []int{44}, []int{6, 22}},
	4:  {18, []int{32, 32}, []int{6, 26}},
	5:  {24, []int{43, 43}, []int{6, 30}},
	6:  {16, []int{27, 27, 27, 27}, []int{6, 34}},
	7:  {18, []int{31, 31, 31, 31}, []int{6, 22, 38}},
	8:  {22, []int{38, 38, 39, 39}, []int{6, 24, 42}},
	9:  {22, []int{36, 36, 36, 37, 37}, []int{6, 26, 46}},
	10: {26, []int{43, 43, 43, 43, 44}, []int{6, 28, 50}},
}

func (v qrVersion) dataCodewords() int {
	n := 0
	for _, d := range v.data {
		n += d
	}
	return n
}

// EncodeQR is text's code as a square of modules, true for dark.
func EncodeQR(text string) ([][]bool, error) {
	version := 0
	for i := 1; i < len(qrVersions); i++ {
		count := 8
		if i >= 10 {
			count = 16
		}
		if 4+count+8*len(text) <= 8*qrVersions[i].dataCodewords() {
			version = i
			break
		}
	}
	if version == 0 {
		return nil, errors.New("too long for a QR code here")
	}
	v := qrVersions[version]
	data := qrData(text, version, v.dataCodewords())
	codewords := qrInterleave(data, v)
	q := newQRMatrix(version)
	q.drawFunctions(v)
	q.drawCodewords(codewords)
	best, bestScore := -1, 0
	for mask := range 8 {
		q.applyMask(mask)
		q.drawFormat(mask)
		if score := q.penalty(); best < 0 || score < bestScore {
			best, bestScore = mask, score
		}
		q.applyMask(mask) // undo: the mask is its own inverse
	}
	q.applyMask(best)
	q.drawFormat(best)
	return q.dark, nil
}

// qrData is the data codewords: byte mode, the count, the bytes, the terminator, and padding.
func qrData(text string, version, capacity int) []byte {
	var bits []bool
	put := func(v, n int) {
		for i := n - 1; i >= 0; i-- {
			bits = append(bits, v>>i&1 == 1)
		}
	}
	put(0b0100, 4)
	count := 8
	if version >= 10 {
		count = 16
	}
	put(len(text), count)
	for i := range len(text) {
		put(int(text[i]), 8)
	}
	put(0, min(4, capacity*8-len(bits)))
	for len(bits)%8 != 0 {
		bits = append(bits, false)
	}
	out := make([]byte, 0, capacity)
	for i := 0; i < len(bits); i += 8 {
		var b byte
		for j := range 8 {
			if bits[i+j] {
				b |= 1 << (7 - j)
			}
		}
		out = append(out, b)
	}
	for pad := byte(0xec); len(out) < capacity; pad ^= 0xec ^ 0x11 {
		out = append(out, pad)
	}
	return out
}

// GF(256) for Reed–Solomon, over x^8+x^4+x^3+x^2+1.
var qrExp, qrLog = func() (exp [512]byte, log [256]int) {
	x := 1
	for i := range 255 {
		exp[i], log[x] = byte(x), i
		x <<= 1
		if x&0x100 != 0 {
			x ^= 0x11d
		}
	}
	for i := 255; i < 512; i++ {
		exp[i] = exp[i-255]
	}
	return
}()

func qrMul(a, b byte) byte {
	if a == 0 || b == 0 {
		return 0
	}
	return qrExp[qrLog[a]+qrLog[b]]
}

// qrEC is a block's n EC codewords: the remainder of data·x^n by the generator ∏(x−α^i).
func qrEC(data []byte, n int) []byte {
	gen := []byte{1}
	for i := range n {
		next := make([]byte, len(gen)+1)
		for j, g := range gen {
			next[j] ^= g
			next[j+1] ^= qrMul(g, qrExp[i])
		}
		gen = next
	}
	rem := make([]byte, n)
	for _, d := range data {
		factor := d ^ rem[0]
		copy(rem, rem[1:])
		rem[n-1] = 0
		for j := range n {
			rem[j] ^= qrMul(gen[j+1], factor)
		}
	}
	return rem
}

// qrInterleave splits data into the version's blocks, adds each one's EC, and interleaves them.
func qrInterleave(data []byte, v qrVersion) []byte {
	var blocks, ecs [][]byte
	at := 0
	for _, n := range v.data {
		blocks = append(blocks, data[at:at+n])
		ecs = append(ecs, qrEC(data[at:at+n], v.ec))
		at += n
	}
	var out []byte
	for i := range v.data[len(v.data)-1] {
		for _, b := range blocks {
			if i < len(b) {
				out = append(out, b[i])
			}
		}
	}
	for i := range v.ec {
		for _, e := range ecs {
			out = append(out, e[i])
		}
	}
	return out
}

type qrMatrix struct {
	size     int
	version  int
	dark     [][]bool
	function [][]bool
}

func newQRMatrix(version int) *qrMatrix {
	size := 17 + 4*version
	q := &qrMatrix{size: size, version: version, dark: make([][]bool, size), function: make([][]bool, size)}
	for i := range size {
		q.dark[i], q.function[i] = make([]bool, size), make([]bool, size)
	}
	return q
}

func (q *qrMatrix) set(r, c int, dark bool) { q.dark[r][c], q.function[r][c] = dark, true }

func (q *qrMatrix) drawFunctions(v qrVersion) {
	for i := range q.size {
		q.set(6, i, i%2 == 0)
		q.set(i, 6, i%2 == 0)
	}
	for _, at := range [][2]int{{3, 3}, {3, q.size - 4}, {q.size - 4, 3}} {
		for dr := -4; dr <= 4; dr++ {
			for dc := -4; dc <= 4; dc++ {
				r, c := at[0]+dr, at[1]+dc
				if r < 0 || c < 0 || r >= q.size || c >= q.size {
					continue
				}
				d := max(abs(dr), abs(dc))
				q.set(r, c, d != 2 && d != 4)
			}
		}
	}
	last := len(v.align) - 1
	for i, r := range v.align {
		for j, c := range v.align {
			if (i == 0 && j == 0) || (i == 0 && j == last) || (i == last && j == 0) {
				continue
			}
			for dr := -2; dr <= 2; dr++ {
				for dc := -2; dc <= 2; dc++ {
					q.set(r+dr, c+dc, max(abs(dr), abs(dc)) != 1)
				}
			}
		}
	}
	q.drawFormat(0) // reserves the format areas; the real bits come with the mask
	if q.version >= 7 {
		rem := q.version
		for range 12 {
			rem = rem<<1 ^ (rem>>11)*0x1f25
		}
		bits := q.version<<12 | rem
		for i := range 18 {
			b := bits>>i&1 == 1
			q.set(i/3, q.size-11+i%3, b)
			q.set(q.size-11+i%3, i/3, b)
		}
	}
}

// drawFormat writes level M's format bits with mask, both copies, and the dark module.
func (q *qrMatrix) drawFormat(mask int) {
	data := 0b00<<3 | mask // level M
	rem := data
	for range 10 {
		rem = rem<<1 ^ (rem>>9)*0x537
	}
	bits := (data<<10 | rem) ^ 0x5412
	b := func(i int) bool { return bits>>i&1 == 1 }
	for i := range 6 {
		q.set(i, 8, b(i))
	}
	q.set(7, 8, b(6))
	q.set(8, 8, b(7))
	q.set(8, 7, b(8))
	for i := 9; i < 15; i++ {
		q.set(8, 14-i, b(i))
	}
	for i := range 8 {
		q.set(8, q.size-1-i, b(i))
	}
	for i := 8; i < 15; i++ {
		q.set(q.size-15+i, 8, b(i))
	}
	q.set(q.size-8, 8, true)
}

// drawCodewords places the codewords in the zigzag, two columns at a time from the bottom right.
func (q *qrMatrix) drawCodewords(codewords []byte) {
	i := 0
	for right := q.size - 1; right >= 1; right -= 2 {
		if right == 6 {
			right = 5
		}
		for v := range q.size {
			for j := range 2 {
				c := right - j
				r := v
				if (right+1)&2 == 0 {
					r = q.size - 1 - v
				}
				if q.function[r][c] {
					continue
				}
				if i < len(codewords)*8 {
					q.dark[r][c] = codewords[i>>3]>>(7-i&7)&1 == 1
				}
				i++
			}
		}
	}
}

func (q *qrMatrix) applyMask(mask int) {
	for r := range q.size {
		for c := range q.size {
			if q.function[r][c] {
				continue
			}
			var flip bool
			switch mask {
			case 0:
				flip = (r+c)%2 == 0
			case 1:
				flip = r%2 == 0
			case 2:
				flip = c%3 == 0
			case 3:
				flip = (r+c)%3 == 0
			case 4:
				flip = (r/2+c/3)%2 == 0
			case 5:
				flip = r*c%2+r*c%3 == 0
			case 6:
				flip = (r*c%2+r*c%3)%2 == 0
			default:
				flip = ((r+c)%2+r*c%3)%2 == 0
			}
			if flip {
				q.dark[r][c] = !q.dark[r][c]
			}
		}
	}
}

// penalty is the standard's four rules: runs, 2×2 blocks, finder-like patterns, and balance.
func (q *qrMatrix) penalty() int {
	score := 0
	at := func(r, c int, across bool) bool {
		if across {
			return q.dark[r][c]
		}
		return q.dark[c][r]
	}
	for _, across := range []bool{true, false} {
		for r := range q.size {
			run := 1
			for c := 1; c <= q.size; c++ {
				if c < q.size && at(r, c, across) == at(r, c-1, across) {
					run++
					continue
				}
				if run >= 5 {
					score += 3 + run - 5
				}
				run = 1
			}
			for c := 0; c+11 <= q.size; c++ {
				var line [11]bool
				for k := range 11 {
					line[k] = at(r, c+k, across)
				}
				a := [11]bool{true, false, true, true, true, false, true, false, false, false, false}
				b := [11]bool{false, false, false, false, true, false, true, true, true, false, true}
				if line == a || line == b {
					score += 40
				}
			}
		}
	}
	dark := 0
	for r := range q.size {
		for c := range q.size {
			if q.dark[r][c] {
				dark++
			}
			if r+1 < q.size && c+1 < q.size {
				d := q.dark[r][c]
				if q.dark[r+1][c] == d && q.dark[r][c+1] == d && q.dark[r+1][c+1] == d {
					score += 3
				}
			}
		}
	}
	total := q.size * q.size
	score += abs(dark*20-total*10) / total * 10
	return score
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// RenderQR draws a code for a terminal: two rows of modules to a line in half blocks, black on
// white whatever the terminal's theme, inside the quiet zone.
func RenderQR(code [][]bool) string {
	size := len(code)
	full := size + 2*QuietZone
	dark := func(r, c int) bool {
		r, c = r-QuietZone, c-QuietZone
		return r >= 0 && c >= 0 && r < size && c < size && code[r][c]
	}
	var b strings.Builder
	for r := 0; r < full; r += 2 {
		b.WriteString("\x1b[30;107m") // black on bright white
		for c := range full {
			top, bottom := dark(r, c), r+1 < full && dark(r+1, c)
			switch {
			case top && bottom:
				b.WriteString("█")
			case top:
				b.WriteString("▀")
			case bottom:
				b.WriteString("▄")
			default:
				b.WriteString(" ")
			}
		}
		b.WriteString("\x1b[0m\n")
	}
	return b.String()
}
