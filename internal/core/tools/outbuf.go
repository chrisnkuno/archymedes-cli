package tools

// outputBuffer keeps a background command's output in bounded memory: the first headMax bytes
// (how it started: the banner, the first error) and a ring of the last tailMax (what it is doing
// now). Every byte has an absolute offset in the stream, counted from 0 over everything written,
// kept or not; a reader holds a cursor in those offsets, so it never sees a byte twice and is told
// exactly how many bytes fell between head and ring while it was not looking.
//
// Writing costs O(bytes written); reading costs O(bytes returned), never O(output so far).
// It is not safe for concurrent use: the job holding it locks around every call.
type outputBuffer struct {
	headMax, tailMax int
	head             []byte
	// tail holds stream bytes from offset headMax on: byte o is at (o-headMax) % tailMax. It grows
	// to tailMax and then wraps, so a short command never allocates the whole ring.
	tail  []byte
	total int64
}

func newOutputBuffer(headMax, tailMax int) *outputBuffer {
	return &outputBuffer{headMax: headMax, tailMax: tailMax}
}

func (b *outputBuffer) write(p []byte) {
	if room := b.headMax - len(b.head); room > 0 && len(p) > 0 {
		if b.head == nil {
			b.head = make([]byte, 0, b.headMax)
		}
		n := min(room, len(p))
		b.head = append(b.head, p[:n]...)
		b.total += int64(n)
		p = p[n:]
	}
	if b.tailMax <= 0 {
		b.total += int64(len(p))
		return
	}
	// More than a ring's worth in one write: only its end can survive, so skip straight to it.
	if len(p) > b.tailMax {
		b.total += int64(len(p) - b.tailMax)
		p = p[len(p)-b.tailMax:]
	}
	for len(p) > 0 {
		var n int
		if len(b.tail) < b.tailMax && b.total-int64(b.headMax) == int64(len(b.tail)) {
			n = min(b.tailMax-len(b.tail), len(p))
			b.reserve(len(b.tail) + n)
			b.tail = append(b.tail, p[:n]...)
		} else {
			b.grow()
			i := int((b.total - int64(b.headMax)) % int64(b.tailMax))
			n = copy(b.tail[i:], p)
		}
		b.total += int64(n)
		p = p[n:]
	}
}

// grow makes the ring its full size, once: a skip past the end of a ring still growing leaves it
// wrapping from a position its length has not reached.
func (b *outputBuffer) grow() {
	if len(b.tail) < b.tailMax {
		b.reserve(b.tailMax)
		b.tail = b.tail[:b.tailMax]
	}
}

// reserve gives the ring room for n bytes, doubling as it grows but never past tailMax, so the
// memory a command holds is bounded by headMax + tailMax exactly.
func (b *outputBuffer) reserve(n int) {
	if n <= cap(b.tail) {
		return
	}
	size := min(b.tailMax, max(n, 2*cap(b.tail), 4096))
	grown := make([]byte, len(b.tail), size)
	copy(grown, b.tail)
	b.tail = grown
}

// Total is how many bytes were ever written.
func (b *outputBuffer) Total() int64 { return b.total }

// Retained is how many bytes are kept now; it is never more than headMax + tailMax.
func (b *outputBuffer) Retained() int64 {
	return int64(len(b.head)) + b.tailEnd() - b.tailStart()
}

// tailStart is the first offset still in the ring.
func (b *outputBuffer) tailStart() int64 {
	start := int64(len(b.head))
	if b.total-int64(b.tailMax) > start {
		start = b.total - int64(b.tailMax)
	}
	return start
}

func (b *outputBuffer) tailEnd() int64 {
	if b.total < int64(len(b.head)) {
		return int64(len(b.head))
	}
	return b.total
}

// chunk is what one read returns: the bytes from Since on, and Dropped bytes skipped between Before
// and After because they were no longer kept. Next is the cursor to pass to the following read.
type chunk struct {
	Since, Next int64
	Before      []byte // the kept bytes before the gap (or all of them when there is none)
	Dropped     int64  // bytes lost between Before and After
	After       []byte
	// Pending is how many bytes were written past Next and not returned because of max.
	Pending int64
}

// Bytes is the returned output without the gap.
func (c chunk) Bytes() []byte {
	if len(c.After) == 0 {
		return c.Before
	}
	return append(append(make([]byte, 0, len(c.Before)+len(c.After)), c.Before...), c.After...)
}

// read returns up to max bytes from cursor since (clamped to [0, total]); max <= 0 means no limit.
// The bytes are copies, so the caller may hold them after unlocking.
func (b *outputBuffer) read(since int64, max int) chunk {
	since = min(max64(since, 0), b.total)
	c := chunk{Since: since}
	pos := since
	room := int64(max)
	if max <= 0 {
		room = b.total
	}
	if headEnd := int64(len(b.head)); pos < headEnd {
		n := min(headEnd-pos, room)
		c.Before = append([]byte(nil), b.head[pos:pos+n]...)
		pos += n
		room -= n
	}
	if start := b.tailStart(); pos < start && pos >= int64(len(b.head)) {
		c.Dropped = start - pos
		pos = start
	}
	if room > 0 && pos < b.total {
		n := min(b.total-pos, room)
		out := b.ringCopy(pos, n)
		if c.Dropped > 0 || len(c.Before) == 0 {
			if c.Dropped > 0 {
				c.After = out
			} else {
				c.Before = out
			}
		} else {
			c.Before = append(c.Before, out...)
		}
		pos += n
	}
	c.Next = pos
	c.Pending = b.total - pos
	return c
}

// ringCopy copies n bytes of the ring starting at absolute offset pos, which must be kept.
func (b *outputBuffer) ringCopy(pos, n int64) []byte {
	out := make([]byte, 0, n)
	for n > 0 {
		i := (pos - int64(b.headMax)) % int64(b.tailMax)
		end := min(int64(len(b.tail)), i+n)
		out = append(out, b.tail[i:end]...)
		n -= end - i
		pos += end - i
	}
	return out
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
