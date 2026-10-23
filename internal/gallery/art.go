package gallery

import (
	"image"
	"image/color"
	"math"
)

// Generated wallpapers: abstract, future-themed pictures drawn by code. They need no licence (they
// are Friday's own), add nothing to the binary but this file, and render at any size, so the
// Gallery shows them as sharp as the terminal allows. Each is deterministic: the same size always
// gives the same picture.

// vec is an RGB colour with float channels, 0..1 (and above, before tone mapping).
type vec struct{ r, g, b float64 }

func (a vec) add(b vec) vec     { return vec{a.r + b.r, a.g + b.g, a.b + b.b} }
func (a vec) mul(k float64) vec { return vec{a.r * k, a.g * k, a.b * k} }
func (a vec) mix(b vec, t float64) vec {
	return vec{a.r + (b.r-a.r)*t, a.g + (b.g-a.g)*t, a.b + (b.b-a.b)*t}
}

func hex(c uint32) vec {
	return vec{float64(c>>16&0xff) / 255, float64(c>>8&0xff) / 255, float64(c&0xff) / 255}
}

func clamp01(x float64) float64 { return math.Max(0, math.Min(1, x)) }

func smoothstep(e0, e1, x float64) float64 {
	t := clamp01((x - e0) / (e1 - e0))
	return t * t * (3 - 2*t)
}

// tone maps a linear colour to 8 bits with a soft shoulder, so glows saturate rather than clip.
func tone(c vec) color.RGBA {
	f := func(x float64) uint8 {
		x = 1 - math.Exp(-x*1.4)
		return uint8(clamp01(math.Pow(x, 1/1.1)) * 255)
	}
	return color.RGBA{f(c.r), f(c.g), f(c.b), 255}
}

// cosine is Inigo Quilez's cosine palette: a + b·cos(2π(c·t + d)).
func cosine(t float64, a, b, c, d vec) vec {
	f := func(a, b, c, d float64) float64 { return a + b*math.Cos(2*math.Pi*(c*t+d)) }
	return vec{f(a.r, b.r, c.r, d.r), f(a.g, b.g, c.g, d.g), f(a.b, b.b, c.b, d.b)}
}

// hash2 is a stable pseudo-random value in 0..1 for an integer lattice point.
func hash2(x, y int) float64 {
	h := uint32(x)*374761393 + uint32(y)*668265263
	h = (h ^ (h >> 13)) * 1274126177
	return float64(h^(h>>16)) / float64(math.MaxUint32)
}

// noise is smooth value noise in about 0..1.
func noise(x, y float64) float64 {
	ix, iy := math.Floor(x), math.Floor(y)
	fx, fy := x-ix, y-iy
	ux, uy := fx*fx*(3-2*fx), fy*fy*(3-2*fy)
	a := hash2(int(ix), int(iy))
	b := hash2(int(ix)+1, int(iy))
	c := hash2(int(ix), int(iy)+1)
	d := hash2(int(ix)+1, int(iy)+1)
	return a + (b-a)*ux + (c-a)*uy + (a-b-c+d)*ux*uy
}

// fbm is noise summed over octaves.
func fbm(x, y float64, octaves int) float64 {
	sum, amp, norm := 0.0, 0.5, 0.0
	for range octaves {
		sum += amp * noise(x, y)
		norm += amp
		x, y = x*2.03+17.1, y*2.03+3.7
		amp *= 0.5
	}
	return sum / norm
}

// stars is a sparse field of points of varying brightness, in a cell grid of the given size.
func stars(x, y, cell float64, density float64) float64 {
	cx, cy := math.Floor(x/cell), math.Floor(y/cell)
	if hash2(int(cx)+911, int(cy)+137) > density {
		return 0
	}
	sx := (cx + 0.15 + 0.7*hash2(int(cx), int(cy)+5)) * cell
	sy := (cy + 0.15 + 0.7*hash2(int(cx)+9, int(cy))) * cell
	d := math.Hypot(x-sx, y-sy) / cell
	return math.Exp(-d*d*900) * (0.4 + 0.6*hash2(int(cx)+3, int(cy)+3))
}

// render calls shade for every pixel with normalized coordinates: u across 0..aspect, v down 0..1.
func render(w, h int, shade func(u, v, aspect float64) vec) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	aspect := float64(w) / float64(h)
	for py := range h {
		v := (float64(py) + 0.5) / float64(h)
		for px := range w {
			u := (float64(px) + 0.5) / float64(h)
			img.SetRGBA(px, py, tone(shade(u, v, aspect)))
		}
	}
	return img
}

// artAurora: thin curtains of green and violet light over a dark horizon.
func artAurora(w, h int) image.Image {
	sky0, sky1 := hex(0x01030a), hex(0x081226)
	green, cyan, violet := hex(0x3dffa8), hex(0x37c8ff), hex(0xb46bff)
	return render(w, h, func(u, v, aspect float64) vec {
		c := sky0.mix(sky1, smoothstep(0, 1, v))
		c = c.add(vec{1, 1, 1}.mul(stars(u, v, 0.018, 0.4) * (1 - v)))
		for i, layer := range []struct{ base, amp, freq, height, gain float64 }{
			{0.46, 0.09, 1.1, 0.34, 1.7}, {0.58, 0.07, 1.9, 0.26, 1.3}, {0.38, 0.06, 2.6, 0.22, 1.0},
		} {
			fi := float64(i)
			// The lower edge of a curtain winds across the sky; light rises from it and fades.
			edge := layer.base + layer.amp*math.Sin(u*layer.freq*math.Pi+fi*1.7) + 0.05*(fbm(u*2.5+fi*4, fi, 4)-0.5)
			above := edge - v
			if above < -0.01 || above > layer.height {
				continue
			}
			rise := smoothstep(-0.01, 0.005, above) * math.Exp(-above/layer.height*3.2)
			// Folds: narrow vertical rays that come and go along the curtain.
			rays := math.Pow(fbm(u*55+fi*13, above*2, 3), 2.2) * 2.2
			gap := smoothstep(0.22, 0.5, fbm(u*1.6+fi*9, fi*3, 3))
			tint := green.mix(cyan, clamp01(above/layer.height*1.5)).mix(violet, clamp01(above/layer.height*2-0.9))
			c = c.add(tint.mul(rise * rays * gap * layer.gain))
		}
		if hill := 0.88 + 0.035*fbm(u*4, 7, 4); v > hill {
			c = hex(0x010208).mix(c, 0.1)
		}
		return c
	})
}

// artSynthwave: a striped sun setting on a neon grid.
func artSynthwave(w, h int) image.Image {
	top, mid, low := hex(0x0d0221), hex(0x2a0a4a), hex(0xff2e88)
	sunTop, sunLow := hex(0xffd319), hex(0xff2975)
	gridColor := hex(0x2de2e6)
	return render(w, h, func(u, v, aspect float64) vec {
		horizon := 0.62
		cx := aspect / 2
		if v < horizon {
			c := top.mix(mid, smoothstep(0, horizon*0.8, v)).mix(low, smoothstep(horizon*0.55, horizon, v)*0.55)
			c = c.add(vec{1, 1, 1}.mul(stars(u, v, 0.025, 0.25) * (1 - v/horizon)))
			// The sun: a disc cut by slits that widen toward the horizon.
			r := 0.27
			d := math.Hypot(u-cx, v-(horizon-0.06))
			if d < r {
				t := (v - (horizon - 0.06 - r)) / (2 * r)
				slit := 1.0
				if t > 0.45 {
					stripe := math.Mod((t-0.45)*24, 1)
					if stripe < 0.18+(t-0.45)*0.9 {
						slit = 0
					}
				}
				c = c.mix(sunTop.mix(sunLow, smoothstep(0.1, 0.9, t)).mul(1.6), slit*smoothstep(r, r-0.004, d))
			}
			c = c.add(sunLow.mul(0.35 * math.Exp(-math.Max(d-r, 0)*9)))
			return c
		}
		// The floor: a perspective grid.
		depth := (v - horizon) / (1 - horizon)
		z := 1 / math.Max(depth, 0.001)
		gx := (u - cx) * z
		gz := z * 0.6
		lineX := math.Abs(math.Mod(gx*2.2+100.5, 1) - 0.5)
		lineZ := math.Abs(math.Mod(gz*0.9, 1) - 0.5)
		width := 0.03 * z
		g := math.Max(smoothstep(width, 0, lineX), smoothstep(width*1.5, 0, lineZ))
		c := hex(0x090018).mix(hex(0x1a0633), depth)
		c = c.add(gridColor.mul(g * (0.25 + depth) * 1.3))
		c = c.add(low.mul(0.6 * math.Exp(-depth*9))) // haze at the horizon
		return c
	})
}

// artNebula: a cloud of gas lit from within, with stars.
func artNebula(w, h int) image.Image {
	return render(w, h, func(u, v, aspect float64) vec {
		x, y := u*2.2, v*2.2
		qx, qy := fbm(x, y, 5), fbm(x+5.2, y+1.3, 5)
		n := fbm(x+3*qx, y+3*qy, 6)
		dense := smoothstep(0.38, 0.85, n)
		col := cosine(n*1.2+qx*0.5, vec{0.25, 0.12, 0.35}, vec{0.35, 0.25, 0.4}, vec{1, 1, 1}, vec{0.65, 0.85, 0.95})
		c := hex(0x03020a).add(col.mul(dense * 1.3))
		core := math.Exp(-math.Pow(math.Hypot(u-aspect*0.62, v-0.45)*2.3, 2))
		c = c.add(hex(0xff6ad5).mix(hex(0x7df9ff), qy).mul(core * dense * 1.2))
		c = c.add(vec{1, 1, 1}.mul(stars(u, v, 0.015, 0.4) * (1 - dense*0.6)))
		return c
	})
}

// artChrome: liquid neon, glowing ridges whose colour turns as they flow.
func artChrome(w, h int) image.Image {
	return render(w, h, func(u, v, aspect float64) vec {
		x, y := u*2.4, v*2.4
		for k := range 5 {
			fk := float64(k)
			x, y = x+0.32*math.Sin(y*(1.7+fk*0.3)+fk), y+0.32*math.Cos(x*(1.5+fk*0.2)-fk)
		}
		ridges := 0.5 + 0.5*math.Sin(x*6+y*2.2)
		body := smoothstep(0.25, 0.75, fbm(u*1.3, v*1.3, 3))
		sheen := cosine(ridges*0.35+u*0.35+fbm(x*0.6, y*0.6, 3)*0.9, vec{0.55, 0.45, 0.65}, vec{0.45, 0.5, 0.35}, vec{1, 1, 1}, vec{0.85, 0.15, 0.5})
		metal := math.Pow(ridges, 3)
		c := hex(0x050509).mix(sheen.mul(0.9), metal*body)
		return c.add(vec{1, 1, 1}.mul(math.Pow(ridges, 30) * body * 0.9))
	})
}

// artEventHorizon: a black hole with its accretion disc and the ring light bends around it.
func artEventHorizon(w, h int) image.Image {
	hot, warm, deep := hex(0xfff3dc), hex(0xff8a2a), hex(0x9b2c00)
	return render(w, h, func(u, v, aspect float64) vec {
		cx, cy := aspect*0.5, 0.5
		dx, dy := u-cx, v-cy
		r := math.Hypot(dx, dy)
		c := hex(0x020208).add(vec{1, 1, 1}.mul(stars(u, v, 0.016, 0.45) * smoothstep(0.2, 0.4, r)))
		// The disc, nearly edge on: a flattened ellipse, brighter on the side turning toward us.
		ed := math.Hypot(dx, dy*4.5)
		turbulence := 0.6 + 0.4*fbm(math.Atan2(dy*4.5, dx)*4, ed*25, 4)
		disc := math.Exp(-math.Pow((ed-0.33)/0.13, 2)) * (0.55 + 0.45*math.Cos(math.Atan2(dy, dx))) * turbulence
		discColor := deep.mix(warm, clamp01(1.4-(ed-0.2)*3)).mix(hot, clamp01(1-(ed-0.18)*6))
		// Light from the far side of the disc, bent up and over the shadow: the bright ring.
		ring := math.Exp(-math.Pow((r-0.165)/0.01, 2))*1.2 + 0.45*math.Exp(-math.Pow((r-0.185)/0.035, 2))
		lit := c.add(discColor.mul(disc * 1.7)).add(warm.mix(hot, 0.7).mul(ring))
		// The shadow hides what is behind it; the near half of the disc passes in front of it.
		front := dy > 0 && math.Abs(dy*4.5) < 0.09 && ed > 0.15
		if r < 0.15 && !front {
			return lit.mul(1 - smoothstep(0.142, 0.15, 0.292-r))
		}
		return lit
	})
}

// artLattice: waves drawn as rows of glowing dots, receding.
func artLattice(w, h int) image.Image {
	gold, cyan := hex(0xffc76b), hex(0x39d0ff)
	const rows = 54.0
	wave := func(u, rv float64) float64 {
		return (0.07*math.Sin(u*2.6+rv*5) + 0.045*math.Sin(u*6.1-rv*8) + 0.035*(fbm(u*1.8, rv*2.5, 3)-0.5)) * (0.5 + rv)
	}
	return render(w, h, func(u, v, aspect float64) vec {
		c := hex(0x030409).mix(hex(0x0a0d1c), v)
		base := math.Floor(v * rows)
		for k := -14.0; k <= 14; k++ {
			row := base + k
			rv := row / rows
			if rv < 0 || rv > 1.05 {
				continue
			}
			y := rv + wave(u, rv)
			if math.Abs(v-y) > 0.02 {
				continue
			}
			spacing := 0.011 + 0.008*rv
			du := math.Mod(u+rv*0.37, spacing) - spacing/2
			size := 0.0016 + 0.003*rv
			d := math.Hypot(du*0.9, v-y)
			dot := math.Exp(-math.Pow(d/size, 2))
			c = c.add(cyan.mix(gold, clamp01(rv*1.2+wave(u, rv)*3)).mul(dot * (0.25 + 1.1*rv)))
		}
		return c
	})
}

// artTunnel: neon rings falling away into the dark.
func artTunnel(w, h int) image.Image {
	pink, blue, cyan := hex(0xff2bd6), hex(0x3a5bff), hex(0x2ef2ff)
	return render(w, h, func(u, v, aspect float64) vec {
		dx, dy := u-aspect/2, v-0.5
		r := math.Hypot(dx*0.9, dy) + 1e-4
		a := math.Atan2(dy, dx)
		depth := 0.22 / r
		ringPos := math.Mod(depth*2.2, 1)
		ring := math.Exp(-math.Pow(math.Min(ringPos, 1-ringPos)/0.035, 2))
		segments := 0.5 + 0.5*math.Cos(a*12+math.Floor(depth*2.2)*0.9)
		ring *= 0.55 + 0.45*segments
		rails := math.Exp(-math.Pow((math.Mod(a/(2*math.Pi)*16+16.5, 1)-0.5)/0.025, 2)) * 0.35
		near := smoothstep(0.03, 0.4, r)
		tint := cyan.mix(blue, clamp01(depth/12)).mix(pink, 0.5+0.5*math.Sin(depth*0.7))
		c := hex(0x03020a).add(tint.mul((ring*1.5 + rails) * near / (1 + depth*0.08)))
		c = c.add(hex(0xd8f6ff).mul(math.Exp(-r*r*900) * 0.8))
		return c
	})
}

// artSilk: dark glass ribbons with bright edges, folding over each other.
func artSilk(w, h int) image.Image {
	edgeA, edgeB := hex(0x8f6bff), hex(0x3fe0ff)
	return render(w, h, func(u, v, aspect float64) vec {
		c := hex(0x04030b)
		for i := range 4 {
			fi := float64(i)
			// A ribbon is a band between two curves that sweep across; its brightness follows
			// the slope, so it reads as a lit, folded surface.
			mid := 0.25 + 0.17*fi + 0.12*math.Sin(u*(1.3+fi*0.4)+fi*2.1) + 0.05*math.Sin(u*3.7-fi)
			width := 0.06 + 0.03*math.Sin(u*2.1+fi*1.3)
			d := (v - mid) / width
			if math.Abs(d) > 1.6 {
				continue
			}
			inside := smoothstep(1, 0.92, math.Abs(d))
			slope := math.Cos(u*(1.3+fi*0.4) + fi*2.1)
			body := hex(0x120a2a).mix(hex(0x1d2a5a), 0.5+0.5*slope).mul(0.6 + 0.4*(1-d*d))
			edge := math.Exp(-math.Pow((math.Abs(d)-0.95)/0.05, 2))
			c = c.mix(body, inside*0.85).add(edgeA.mix(edgeB, 0.5+0.5*slope).mul(edge * 0.9))
			c = c.add(vec{1, 1, 1}.mul(math.Exp(-math.Pow((d+0.55)/0.08, 2)) * math.Pow(clamp01(slope), 4) * 0.35 * inside))
		}
		return c
	})
}
