// app.ico 생성기: go run ./tools/mkicon app.ico
// 둥근 사각형 위에 파랑(Outlook)/빨강(웹메일) 반반 봉투 아이콘. PNG 내장 ICO 형식.
package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
)

func inRoundRect(x, y, x0, y0, x1, y1, r float64) bool {
	if x < x0 || x > x1 || y < y0 || y > y1 {
		return false
	}
	cx := math.Max(x0+r, math.Min(x, x1-r))
	cy := math.Max(y0+r, math.Min(y, y1-r))
	return (x-cx)*(x-cx)+(y-cy)*(y-cy) <= r*r
}

func distSeg(px, py, ax, ay, bx, by float64) float64 {
	dx, dy := bx-ax, by-ay
	t := math.Max(0, math.Min(1, ((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy)))
	ex, ey := ax+t*dx-px, ay+t*dy-py
	return math.Hypot(ex, ey)
}

// 256 기준 좌표계에서 한 점의 색
func sample(x, y float64) color.NRGBA {
	var c color.NRGBA
	if inRoundRect(x, y, 8, 8, 248, 248, 48) {
		c = color.NRGBA{27, 31, 39, 255}
	}
	if x >= 40 && x <= 216 && y >= 72 && y <= 184 {
		if x < 128 {
			c = color.NRGBA{15, 108, 189, 255}
		} else {
			c = color.NRGBA{197, 34, 31, 255}
		}
		if distSeg(x, y, 40, 72, 128, 136) <= 6 || distSeg(x, y, 128, 136, 216, 72) <= 6 {
			c = color.NRGBA{255, 255, 255, 255}
		}
	}
	return c
}

func render(size int) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	const ss = 4 // 슈퍼샘플링
	scale := 256.0 / float64(size)
	for py := 0; py < size; py++ {
		for px := 0; px < size; px++ {
			var r, g, b, a float64
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					c := sample((float64(px)+(float64(sx)+.5)/ss)*scale, (float64(py)+(float64(sy)+.5)/ss)*scale)
					fa := float64(c.A) / 255
					r += float64(c.R) * fa
					g += float64(c.G) * fa
					b += float64(c.B) * fa
					a += fa
				}
			}
			n := float64(ss * ss)
			if a > 0 {
				img.SetNRGBA(px, py, color.NRGBA{uint8(r / a), uint8(g / a), uint8(b / a), uint8(a / n * 255)})
			}
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

func main() {
	outPath := "app.ico"
	if len(os.Args) > 1 {
		outPath = os.Args[1]
	}
	sizes := []int{16, 24, 32, 48, 64, 128, 256}
	var pngs [][]byte
	for _, s := range sizes {
		pngs = append(pngs, render(s))
	}
	var out bytes.Buffer
	binary.Write(&out, binary.LittleEndian, [3]uint16{0, 1, uint16(len(sizes))})
	offset := 6 + 16*len(sizes)
	for i, s := range sizes {
		d := uint8(s)
		if s >= 256 {
			d = 0
		}
		binary.Write(&out, binary.LittleEndian, struct {
			W, H, Colors, Reserved uint8
			Planes, BitCount       uint16
			Size, Offset           uint32
		}{d, d, 0, 0, 1, 32, uint32(len(pngs[i])), uint32(offset)})
		offset += len(pngs[i])
	}
	for _, p := range pngs {
		out.Write(p)
	}
	if err := os.WriteFile(outPath, out.Bytes(), 0o644); err != nil {
		panic(err)
	}
}
