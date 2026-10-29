package tools

import (
	"math/rand"
	"runtime"
	"testing"
)

// at is the byte the test stream holds at absolute offset o, so any byte a read returns can be
// checked against where the read says it came from.
func at(o int64) byte { return byte((o*7 + o/251) % 251) }

func stream(from int64, n int) []byte {
	p := make([]byte, n)
	for i := range p {
		p[i] = at(from + int64(i))
	}
	return p
}

// checkChunk holds one read to the buffer's contract and returns how many bytes it delivered.
func checkChunk(t *testing.T, b *outputBuffer, c chunk, since int64, max int) int64 {
	t.Helper()
	if c.Since != min(max64(since, 0), b.Total()) {
		t.Fatalf("read(%d) began at %d", since, c.Since)
	}
	if c.Next < c.Since || c.Next > b.Total() {
		t.Fatalf("cursor %d -> %d outside [since, total=%d]", c.Since, c.Next, b.Total())
	}
	if c.Next != c.Since+int64(len(c.Before))+c.Dropped+int64(len(c.After)) {
		t.Fatalf("next %d does not account for since %d + %d + dropped %d + %d", c.Next, c.Since, len(c.Before), c.Dropped, len(c.After))
	}
	if c.Pending != b.Total()-c.Next {
		t.Fatalf("pending %d, want %d", c.Pending, b.Total()-c.Next)
	}
	if max > 0 && len(c.Before)+len(c.After) > max {
		t.Fatalf("read returned %d bytes, more than max %d", len(c.Before)+len(c.After), max)
	}
	if len(c.After) > 0 && c.Dropped == 0 {
		t.Fatal("After without a gap")
	}
	for i, got := range c.Before {
		if want := at(c.Since + int64(i)); got != want {
			t.Fatalf("byte at %d is %d, want %d", c.Since+int64(i), got, want)
		}
	}
	afterAt := c.Since + int64(len(c.Before)) + c.Dropped
	for i, got := range c.After {
		if want := at(afterAt + int64(i)); got != want {
			t.Fatalf("byte at %d (after the gap) is %d, want %d", afterAt+int64(i), got, want)
		}
	}
	if c.Dropped > 0 {
		// A gap is exactly the bytes no longer kept: it starts at or past the head and ends where
		// the ring begins.
		gapAt := c.Since + int64(len(c.Before))
		if gapAt < int64(len(b.head)) || gapAt+c.Dropped != b.tailStart() {
			t.Fatalf("gap [%d, %d) is not the dropped range [≥%d, %d)", gapAt, gapAt+c.Dropped, len(b.head), b.tailStart())
		}
	}
	return int64(len(c.Before) + len(c.After))
}

// TestOutputBufferInvariants: for random limits, write sizes and read sizes, (1) the bytes kept
// never exceed head + ring and the memory held never exceeds them either; (2) a reader following
// its cursors gets every byte at most once, at the offset it is told, and every byte it did not get
// is reported as dropped, so delivered + dropped == written; (3) cursors only move forward.
func TestOutputBufferInvariants(t *testing.T) {
	for seed := int64(1); seed <= 300; seed++ {
		rng := rand.New(rand.NewSource(seed))
		headMax, tailMax := rng.Intn(64), 1+rng.Intn(300)
		b := newOutputBuffer(headMax, tailMax)
		var cursor, delivered, dropped int64
		for step := 0; step < 200; step++ {
			if rng.Intn(3) > 0 {
				n := rng.Intn(3 * tailMax / 2)
				if rng.Intn(20) == 0 {
					n = 0
				}
				b.write(stream(b.Total(), n))
			}
			if b.Retained() > int64(headMax+tailMax) {
				t.Fatalf("seed %d: %d bytes kept, bound %d", seed, b.Retained(), headMax+tailMax)
			}
			if cap(b.head) > headMax || cap(b.tail) > tailMax {
				t.Fatalf("seed %d: holds %d + %d bytes of memory, bound %d + %d", seed, cap(b.head), cap(b.tail), headMax, tailMax)
			}
			if rng.Intn(2) == 0 {
				max := rng.Intn(200)
				c := b.read(cursor, max)
				delivered += checkChunk(t, b, c, cursor, max)
				dropped += c.Dropped
				if c.Next < cursor {
					t.Fatalf("seed %d: cursor went back from %d to %d", seed, cursor, c.Next)
				}
				cursor = c.Next
			}
		}
		for cursor < b.Total() {
			c := b.read(cursor, 50)
			delivered += checkChunk(t, b, c, cursor, 50)
			dropped += c.Dropped
			if c.Next == cursor {
				t.Fatalf("seed %d: a read made no progress at %d of %d", seed, cursor, b.Total())
			}
			cursor = c.Next
		}
		if delivered+dropped != b.Total() {
			t.Fatalf("seed %d: delivered %d + dropped %d != written %d", seed, delivered, dropped, b.Total())
		}
		// At the end, with nothing new, a read returns nothing and stays put.
		if c := b.read(cursor, 0); c.Next != cursor || len(c.Before)+len(c.After) != 0 || c.Dropped != 0 {
			t.Fatalf("seed %d: a read at the end returned %+v", seed, c)
		}
	}
}

// TestOutputBufferReadFromStartIsHeadGapThenRing: one read of everything is the head, the dropped
// count, and the ring, in that order.
func TestOutputBufferReadFromStartIsHeadGapThenRing(t *testing.T) {
	b := newOutputBuffer(10, 100)
	b.write(stream(0, 1000))
	c := b.read(0, 0)
	checkChunk(t, b, c, 0, 0)
	if len(c.Before) != 10 || c.Dropped != 890 || len(c.After) != 100 || c.Next != 1000 {
		t.Fatalf("got head %d, dropped %d, ring %d, next %d", len(c.Before), c.Dropped, len(c.After), c.Next)
	}
}

// TestOutputBufferStaleCursorIsReportedNotSkipped: a cursor into bytes since dropped gets the
// count of what it missed, then the kept bytes.
func TestOutputBufferStaleCursorIsReportedNotSkipped(t *testing.T) {
	b := newOutputBuffer(10, 100)
	b.write(stream(0, 1000))
	c := b.read(50, 0)
	checkChunk(t, b, c, 50, 0)
	if c.Dropped != 850 || len(c.Before) != 0 || len(c.After) != 100 {
		t.Fatalf("stale cursor: %+v", c)
	}
	// A cursor past the end is clamped to it, not trusted.
	if c := b.read(5000, 0); c.Since != 1000 || c.Next != 1000 {
		t.Fatalf("cursor past the end: %+v", c)
	}
	if c := b.read(-5, 20); c.Since != 0 {
		t.Fatalf("negative cursor: %+v", c)
	}
}

// TestOutputBufferHugeWrite: one write larger than the ring keeps only its end, counted.
func TestOutputBufferHugeWrite(t *testing.T) {
	b := newOutputBuffer(4, 16)
	b.write(stream(0, 3))
	b.write(stream(3, 1000))
	c := b.read(0, 0)
	checkChunk(t, b, c, 0, 0)
	if b.Total() != 1003 || b.Retained() != 20 || c.Dropped != 1003-20 {
		t.Fatalf("total %d retained %d dropped %d", b.Total(), b.Retained(), c.Dropped)
	}
}

// TestOutputBufferReadCostsNewBytesNotHistory: after 50 MB of output, reading the newest 100 bytes
// allocates about 100 bytes, and the buffer holds no more than its bound.
func TestOutputBufferReadCostsNewBytesNotHistory(t *testing.T) {
	b := newOutputBuffer(CommandHeadBytes, CommandTailBytes)
	const total = 50 << 20
	chunkSize := 64 << 10
	for b.Total() < total {
		b.write(stream(b.Total(), chunkSize))
	}
	if b.Retained() > CommandHeadBytes+CommandTailBytes || cap(b.head)+cap(b.tail) > CommandHeadBytes+CommandTailBytes {
		t.Fatalf("after 50 MB: %d kept, %d held", b.Retained(), cap(b.head)+cap(b.tail))
	}
	cursor := b.Total()
	b.write(stream(cursor, 100))
	var before, after runtime.MemStats
	const reads = 1000
	runtime.GC()
	runtime.ReadMemStats(&before)
	for range reads {
		c := b.read(cursor, CommandReadMax)
		if len(c.Before) != 100 {
			t.Fatalf("read %d bytes, want 100", len(c.Before))
		}
	}
	runtime.ReadMemStats(&after)
	if per := (after.TotalAlloc - before.TotalAlloc) / reads; per > 1024 {
		t.Fatalf("a read of 100 new bytes allocated %d bytes: it is scanning history", per)
	}
}

func BenchmarkOutputBufferReadNewAfter50MB(b *testing.B) {
	buf := newOutputBuffer(CommandHeadBytes, CommandTailBytes)
	for buf.Total() < 50<<20 {
		buf.write(stream(buf.Total(), 64<<10))
	}
	cursor := buf.Total()
	buf.write(stream(cursor, 4096))
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		buf.read(cursor, CommandReadMax)
	}
}

func BenchmarkOutputBufferWrite(b *testing.B) {
	buf := newOutputBuffer(CommandHeadBytes, CommandTailBytes)
	p := stream(0, 32<<10)
	b.SetBytes(int64(len(p)))
	b.ReportAllocs()
	for range b.N {
		buf.write(p)
	}
}
