// Package prism draws the Archymedes mark as a lit 3D object: two nested tetrahedra joined at their
// vertices (the triangular analogue of a hypercube), ray traced. The outer one is tinted glass with
// polished edges, the inner one a lit crystal core, every vertex a small glowing joint; a key, a
// fill and a rim light give it highlights that move as it turns, and it casts a soft shadow on a
// floor that also faintly reflects it. The result is an image; glyphs.go turns an image into
// best-fit block characters for any truecolor terminal, and the interface sends the same image as
// Sixel where the terminal draws that.
package prism

import (
	"image"
	"image/color"
	"math"
)

// Pose is how the mark is turned: Yaw about the vertical axis, Tilt towards the viewer, both in
// radians, and Breath, a slow 0–1 swell of the inner core.
type Pose struct {
	Yaw, Tilt, Breath float64
	// Bold is for small renders (a few terminal cells): thicker edges and joints, and fainter glass,
	// so the structure survives being drawn in a couple of hundred cells. 0 is the true proportions.
	Bold float64
}

// Palette is the theme's colours the mark is lit in, and the background it is drawn over.
type Palette struct {
	Primary, Secondary, Accent, Background color.Color
}

type vec [3]float64

func (a vec) add(b vec) vec     { return vec{a[0] + b[0], a[1] + b[1], a[2] + b[2]} }
func (a vec) sub(b vec) vec     { return vec{a[0] - b[0], a[1] - b[1], a[2] - b[2]} }
func (a vec) mul(s float64) vec { return vec{a[0] * s, a[1] * s, a[2] * s} }
func (a vec) dot(b vec) float64 { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2] }
func (a vec) cross(b vec) vec {
	return vec{a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]}
}
func (a vec) length() float64     { return math.Sqrt(a.dot(a)) }
func (a vec) norm() vec           { return a.mul(1 / math.Max(a.length(), 1e-12)) }
func mix(a, b vec, t float64) vec { return a.mul(1 - t).add(b.mul(t)) }

// linear is c as linear-light RGB in 0–1, which is what light adds up in.
func linear(c color.Color) vec {
	if c == nil {
		return vec{}
	}
	r, g, b, _ := c.RGBA()
	f := func(v uint32) float64 {
		x := float64(v) / 65535
		if x <= 0.04045 {
			return x / 12.92
		}
		return math.Pow((x+0.055)/1.055, 2.4)
	}
	return vec{f(r), f(g), f(b)}
}

// srgb is linear light back to an 8-bit channel, tone-mapped so highlights roll off instead of clip.
func srgb(x float64) uint8 {
	x = x / (1 + 0.25*x) * 1.25 // gentle shoulder: 1 stays 1, 2 becomes ~1.67
	x = math.Max(0, math.Min(1, x))
	if x <= 0.0031308 {
		x *= 12.92
	} else {
		x = 1.055*math.Pow(x, 1/2.4) - 0.055
	}
	return uint8(math.Round(x * 255))
}

// The mark's vertices, as identity.ts has them (render.Geometry draws the same solid in text).
var tetra = [4]vec{{0, 1.15, 0}, {-1, -0.7, 0.65}, {1, -0.7, 0.65}, {0, -0.7, -1}}

const innerScale = 0.43

type material int

const (
	matRod material = iota
	matStrut
	matJoint
	matGlass
	matCore
)

type hit struct {
	t   float64
	n   vec // surface normal, facing the ray
	mat material
	p   vec
}

type capsule struct {
	a, b vec
	r    float64
	mat  material
}

type sphere struct {
	c   vec
	r   float64
	mat material
}

type triangle struct {
	a, b, c vec
	mat     material
}

// scene is the mark in one pose, in world space.
type scene struct {
	capsules  []capsule
	spheres   []sphere
	triangles []triangle
	floorY    float64
	glass     float64 // how much the glass shows: 1 at true proportions, less when bold
	lowY      float64 // the lowest and highest points, for the colour ramp
	highY     float64
	pal       struct{ primary, secondary, accent, bg vec }
}

func newScene(pose Pose, pal Palette) *scene {
	s := &scene{}
	s.pal.primary, s.pal.secondary, s.pal.accent, s.pal.bg = linear(pal.Primary), linear(pal.Secondary), linear(pal.Accent), linear(pal.Background)
	var centre vec
	for _, v := range tetra {
		centre = centre.add(v.mul(0.25))
	}
	cy, sy := math.Cos(pose.Yaw), math.Sin(pose.Yaw)
	ct, st := math.Cos(pose.Tilt), math.Sin(pose.Tilt)
	place := func(v vec, scale float64) vec {
		v = v.sub(centre).mul(scale)
		x, z := v[0]*cy+v[2]*sy, -v[0]*sy+v[2]*cy // yaw
		y, z2 := v[1]*ct-z*st, v[1]*st+z*ct       // tilt towards the viewer
		return vec{x, y + 0.12, z2}
	}
	inner := innerScale * (1 + 0.04*pose.Breath)
	var outerV, innerV [4]vec
	s.lowY, s.highY = math.Inf(1), math.Inf(-1)
	for i, v := range tetra {
		outerV[i], innerV[i] = place(v, 1), place(v, inner)
		s.lowY, s.highY = math.Min(s.lowY, outerV[i][1]), math.Max(s.highY, outerV[i][1])
	}
	s.floorY = -1.02
	k := 1 + 1.4*pose.Bold
	s.glass = 1 - 0.6*pose.Bold
	edges := [6][2]int{{0, 1}, {0, 2}, {0, 3}, {1, 2}, {1, 3}, {2, 3}}
	for _, e := range edges {
		s.capsules = append(s.capsules,
			capsule{outerV[e[0]], outerV[e[1]], 0.045 * k, matRod},
			capsule{innerV[e[0]], innerV[e[1]], 0.03 * k, matRod})
	}
	for i := range 4 {
		s.capsules = append(s.capsules, capsule{outerV[i], innerV[i], 0.022 * k, matStrut})
		s.spheres = append(s.spheres, sphere{outerV[i], 0.085 * (1 + 0.8*pose.Bold), matJoint}, sphere{innerV[i], 0.055 * (1 + 0.8*pose.Bold), matJoint})
	}
	faces := [4][3]int{{0, 1, 2}, {0, 2, 3}, {0, 3, 1}, {1, 3, 2}}
	for _, f := range faces {
		s.triangles = append(s.triangles,
			triangle{outerV[f[0]], outerV[f[1]], outerV[f[2]], matGlass},
			triangle{innerV[f[0]], innerV[f[1]], innerV[f[2]], matCore})
	}
	return s
}

// --- intersections ---

func (c capsule) intersect(ro, rd vec) (float64, vec, bool) {
	// Inigo Quilez's ray–capsule intersection.
	ba, oa := c.b.sub(c.a), ro.sub(c.a)
	baba, bard, baoa := ba.dot(ba), ba.dot(rd), ba.dot(oa)
	rdoa, oaoa := rd.dot(oa), oa.dot(oa)
	a := baba - bard*bard
	b := baba*rdoa - baoa*bard
	cc := baba*oaoa - baoa*baoa - c.r*c.r*baba
	h := b*b - a*cc
	if h >= 0 && a > 1e-12 {
		t := (-b - math.Sqrt(h)) / a
		y := baoa + t*bard
		if y > 0 && y < baba && t > 1e-4 {
			p := ro.add(rd.mul(t))
			n := p.sub(c.a.add(ba.mul(y / baba))).norm()
			return t, n, true
		}
		// The caps.
		oc := oa
		if y > 0 {
			oc = ro.sub(c.b)
		}
		b = rd.dot(oc)
		cc = oc.dot(oc) - c.r*c.r
		h = b*b - cc
		if h > 0 {
			t = -b - math.Sqrt(h)
			if t > 1e-4 {
				p := ro.add(rd.mul(t))
				centre := c.a
				if y > 0 {
					centre = c.b
				}
				return t, p.sub(centre).norm(), true
			}
		}
	}
	return 0, vec{}, false
}

func (s sphere) intersect(ro, rd vec) (float64, vec, bool) {
	oc := ro.sub(s.c)
	b := oc.dot(rd)
	c := oc.dot(oc) - s.r*s.r
	h := b*b - c
	if h < 0 {
		return 0, vec{}, false
	}
	t := -b - math.Sqrt(h)
	if t <= 1e-4 {
		return 0, vec{}, false
	}
	return t, ro.add(rd.mul(t)).sub(s.c).norm(), true
}

func (tr triangle) intersect(ro, rd vec) (float64, vec, bool) {
	// Möller–Trumbore, two-sided.
	e1, e2 := tr.b.sub(tr.a), tr.c.sub(tr.a)
	p := rd.cross(e2)
	det := e1.dot(p)
	if math.Abs(det) < 1e-9 {
		return 0, vec{}, false
	}
	inv := 1 / det
	tv := ro.sub(tr.a)
	u := tv.dot(p) * inv
	if u < 0 || u > 1 {
		return 0, vec{}, false
	}
	q := tv.cross(e1)
	v := rd.dot(q) * inv
	if v < 0 || u+v > 1 {
		return 0, vec{}, false
	}
	t := e2.dot(q) * inv
	if t <= 1e-4 {
		return 0, vec{}, false
	}
	return t, e1.cross(e2).norm(), true
}

// hits is every surface along the ray, nearest first (few enough to sort by insertion).
func (s *scene) hits(ro, rd vec, buf []hit) []hit {
	buf = buf[:0]
	add := func(t float64, n vec, m material) {
		if n.dot(rd) > 0 {
			n = n.mul(-1)
		}
		h := hit{t: t, n: n, mat: m, p: ro.add(rd.mul(t))}
		i := len(buf)
		buf = append(buf, h)
		for i > 0 && buf[i-1].t > h.t {
			buf[i], buf[i-1] = buf[i-1], buf[i]
			i--
		}
	}
	for _, c := range s.capsules {
		if t, n, ok := c.intersect(ro, rd); ok {
			add(t, n, c.mat)
		}
	}
	for _, sp := range s.spheres {
		if t, n, ok := sp.intersect(ro, rd); ok {
			add(t, n, sp.mat)
		}
	}
	for _, tr := range s.triangles {
		if t, n, ok := tr.intersect(ro, rd); ok {
			add(t, n, tr.mat)
		}
	}
	return buf
}

// occlusion is how much light the mark blocks between p and a light: 1 for an edge, a joint or
// the core, a little for glass.
func (s *scene) occlusion(p, l vec) float64 {
	block := 0.0
	for _, c := range s.capsules {
		if _, _, ok := c.intersect(p, l); ok {
			return 1
		}
	}
	for _, sp := range s.spheres {
		if _, _, ok := sp.intersect(p, l); ok {
			return 1
		}
	}
	for _, tr := range s.triangles {
		if _, _, ok := tr.intersect(p, l); ok {
			if tr.mat == matCore {
				return 1
			}
			block += 0.18 // light passes through glass, a little dimmed
		}
	}
	return math.Min(block, 1)
}

// --- shading ---

var (
	keyLight  = vec{-0.55, 0.75, 0.62}.norm()
	fillLight = vec{0.8, 0.15, 0.45}.norm()
	rimLight  = vec{0.35, 0.45, -1}.norm()
)

// ramp is the theme's colour at height y: secondary at the foot, primary at the apex.
func (s *scene) ramp(y float64) vec {
	t := (y - s.lowY) / math.Max(s.highY-s.lowY, 1e-6)
	return mix(s.pal.secondary, s.pal.primary, math.Max(0, math.Min(1, t)))
}

func blinn(n, v, l vec, power float64) float64 {
	h := l.add(v).norm()
	return math.Pow(math.Max(n.dot(h), 0), power)
}

func fresnel(n, v vec, f0 float64) float64 {
	return f0 + (1-f0)*math.Pow(1-math.Max(n.dot(v), 0), 5)
}

// sky is what a reflection sees: a soft studio — light above, the background below.
func (s *scene) sky(r vec) vec {
	t := 0.5 + 0.5*r[1]
	studio := vec{0.9, 0.92, 1}
	return mix(s.pal.bg.mul(0.6), studio, t*t).add(vec{1, 1, 1}.mul(3 * math.Pow(math.Max(r.dot(keyLight), 0), 60)))
}

// shade is the colour and opacity of one surface hit seen along rd.
func (s *scene) shade(h hit, rd vec) (vec, float64) {
	v := rd.mul(-1)
	n := h.n
	diffuse := func(base vec, wrap float64) vec {
		k := (math.Max(n.dot(keyLight)+wrap, 0) / (1 + wrap)) * 1.05
		f := math.Max(n.dot(fillLight), 0) * 0.35
		return base.mul(0.16 + k + f)
	}
	switch h.mat {
	case matRod, matStrut:
		// Polished metal in the theme's colour: a coloured highlight, a white glint, a rim.
		base := s.ramp(h.p[1])
		c := diffuse(base, 0).mul(0.75)
		c = c.add(base.mul(1.2 * blinn(n, v, keyLight, 24)))
		c = c.add(vec{1, 1, 1}.mul(1.6 * blinn(n, v, keyLight, 140)))
		c = c.add(s.pal.accent.mul(0.9 * blinn(n, v, rimLight, 30)))
		c = c.add(s.sky(rd.sub(n.mul(2 * rd.dot(n)))).mul(0.25 * fresnel(n, v, 0.3)))
		if h.mat == matStrut {
			c = c.mul(0.85)
		}
		return c, 1
	case matJoint:
		// Small glowing spheres: lit, and a little light of their own.
		base := mix(s.pal.accent, vec{1, 1, 1}, 0.25)
		c := diffuse(base, 0.3).add(base.mul(0.45))
		c = c.add(vec{1, 1, 1}.mul(2.2 * blinn(n, v, keyLight, 90)))
		return c, 1
	case matCore:
		// A crystal core: lit through (wrapped diffuse), glowing faintly, sharp highlights.
		base := mix(s.pal.secondary, s.pal.accent, 0.35).mul(1.15)
		c := diffuse(base, 0.6).add(base.mul(0.22))
		c = c.add(vec{1, 1, 1}.mul(1.4 * blinn(n, v, keyLight, 60)))
		c = c.add(s.sky(rd.sub(n.mul(2 * rd.dot(n)))).mul(0.3 * fresnel(n, v, 0.06)))
		return c, 1
	}
	// Glass: mostly clear, faintly tinted, reflecting the studio at grazing angles, with a sharp
	// highlight where it faces the key light.
	f := fresnel(n, v, 0.04)
	tint := s.ramp(h.p[1]).mul(0.55)
	c := tint.add(s.sky(rd.sub(n.mul(2 * rd.dot(n)))).mul(0.55 * f)).add(vec{1, 1, 1}.mul(2.2 * blinn(n, v, keyLight, 260)))
	return c, (0.07 + 0.45*f) * s.glass
}

// trace is the colour and coverage seen along one ray: the mark's surfaces front to back (glass
// lets what is behind show), then the floor's shadow and reflection under it.
func (s *scene) trace(ro, rd vec, buf []hit, depth int) (vec, float64) {
	var col vec
	alpha := 0.0
	floorT := math.Inf(1)
	if rd[1] < 0 {
		floorT = (s.floorY - ro[1]) / rd[1]
	}
	for _, h := range s.hits(ro, rd, buf) {
		if h.t > floorT {
			break
		}
		c, a := s.shade(h, rd)
		col = col.add(c.mul((1 - alpha) * a))
		alpha += (1 - alpha) * a
		if alpha > 0.995 {
			return col, 1
		}
	}
	if math.IsInf(floorT, 1) || depth > 0 {
		return col, alpha
	}
	// The floor: invisible itself, it shows the mark's shadow and a faint reflection, fading out
	// with distance from under the mark.
	p := ro.add(rd.mul(floorT))
	fade := math.Max(0, 1-math.Hypot(p[0], p[2]+0.1)/1.9)
	if fade <= 0 {
		return col, alpha
	}
	shadow := 0.0
	for _, j := range [3]vec{{0, 0, 0}, {0.06, 0, 0.04}, {-0.05, 0.03, -0.05}} { // a soft light
		shadow += s.occlusion(p, keyLight.add(j).norm()) / 3
	}
	refl, reflA := s.trace(p, vec{rd[0], -rd[1], rd[2]}, buf, depth+1)
	fc := refl.mul(0.18 * reflA)
	fa := math.Min(1, 0.6*shadow*fade+0.18*reflA*fade)
	col = col.add(fc.mul((1 - alpha) * fade))
	alpha += (1 - alpha) * fa
	return col, alpha
}

// Render draws the mark in pose into an image w×h pixels whose pixels are aspect times as wide as
// they are tall, supersampled ss×ss. Each pixel is the colour over the palette's background, and
// its alpha is how much of it is the mark (0 is background only).
func Render(pose Pose, pal Palette, w, h int, aspect float64, ss int) *image.NRGBA {
	s := newScene(pose, pal)
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	ss = max(ss, 1)
	ro := vec{0, 0.34, 5.2} // level with the middle of the mark and its shadow
	const tanHalf = 0.3     // vertical half-height of the view at distance 1: the mark fills its box
	physical := float64(w) * aspect / float64(h)
	buf := make([]hit, 0, 16)
	for y := range h {
		for x := range w {
			var sum vec
			cover := 0.0
			for sy := range ss {
				for sx := range ss {
					u := ((float64(x)+(float64(sx)+0.5)/float64(ss))/float64(w)*2 - 1) * physical * tanHalf
					vv := (1 - (float64(y)+(float64(sy)+0.5)/float64(ss))/float64(h)*2) * tanHalf
					c, a := s.trace(ro, vec{u, vv, -1}.norm(), buf, 0)
					sum = sum.add(c)
					cover += a
				}
			}
			n := float64(ss * ss)
			cover /= n
			// Over the background: what the terminal shows where the mark is not.
			final := sum.mul(1 / n).add(s.pal.bg.mul(1 - cover))
			img.SetNRGBA(x, y, color.NRGBA{srgb(final[0]), srgb(final[1]), srgb(final[2]), uint8(math.Round(cover * 255))})
		}
	}
	return img
}
