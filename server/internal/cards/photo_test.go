package cards

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"strings"
	"testing"

	"github.com/boltcard/karto/server/internal/store"
)

// testJPEG encodes a w×h picture at quality q. noise makes it hard to
// compress, for a file over 64 KB.
func testJPEG(t *testing.T, w, h, q int, noise bool) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	seed := uint32(1)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := color.RGBA{uint8(x), uint8(y), 128, 255}
			if noise {
				seed = seed*1664525 + 1013904223
				c = color.RGBA{uint8(seed >> 24), uint8(seed >> 16), uint8(seed >> 8), 255}
			}
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: q}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// withEXIF puts an EXIF (APP1) segment straight after the JPEG's SOI marker,
// as a camera's file has one.
func withEXIF(b []byte) []byte {
	payload := []byte("Exif\x00\x00MM\x00\x2a\x00\x00\x00\x08")
	n := len(payload) + 2
	seg := append([]byte{0xff, 0xe1, byte(n >> 8), byte(n)}, payload...)
	return append(append(append([]byte{}, b[:2]...), seg...), b[2:]...)
}

// withSize rewrites the width and height in the JPEG's SOF0 header, leaving
// the picture as it is: a small file that claims a huge picture.
func withSize(t *testing.T, b []byte, w, h int) []byte {
	t.Helper()
	out := append([]byte{}, b...)
	for i := 2; i+9 < len(out); {
		marker := out[i+1]
		if marker == 0xc0 {
			out[i+5], out[i+6] = byte(h>>8), byte(h)
			out[i+7], out[i+8] = byte(w>>8), byte(w)
			return out
		}
		i += 2 + int(out[i+2])<<8 + int(out[i+3])
	}
	t.Fatal("no SOF0 header")
	return nil
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// A photo is kept only if it is a whole JPEG of
// exactly 428×270, at most 64 KB, without EXIF.
func TestSetPhotoChecksTheJPEG(t *testing.T) {
	ctx := context.Background()
	svc, st := newService(t)
	if _, err := st.ReserveCard(ctx, cardID, "A", ""); err != nil {
		t.Fatal(err)
	}
	good := testJPEG(t, 428, 270, 80, false)

	tag, err := svc.SetPhoto(ctx, cardID, b64(good))
	if err != nil || tag != store.PhotoTag(good) {
		t.Fatalf("a good photo: %q %v", tag, err)
	}
	jpegBytes, got, err := svc.Photo(ctx, cardID)
	if err != nil || got != tag || !bytes.Equal(jpegBytes, good) {
		t.Fatalf("read back: %q %v", got, err)
	}
	if tags, err := svc.PhotoTags(ctx); err != nil || tags[cardID] != tag {
		t.Fatalf("tags: %v %v", tags, err)
	}

	big := testJPEG(t, 428, 270, 100, true)
	if len(big) <= MaxPhotoBytes {
		t.Fatalf("the noisy JPEG is only %d bytes", len(big))
	}
	for _, c := range []struct {
		name, b64, want string
	}{
		{"one pixel narrower", b64(testJPEG(t, 427, 270, 80, false)), "427×270, must be 428×270"},
		{"one pixel taller", b64(testJPEG(t, 428, 271, 80, false)), "428×271, must be 428×270"},
		{"over 64 KB", b64(big), "at most 65536"},
		{"not a JPEG", b64([]byte("\x89PNG\r\n\x1a\nnot a jpeg")), "not a JPEG"},
		{"cut short", b64(good[:len(good)/2]), "doesn't decode"},
		{"with EXIF", b64(withEXIF(good)), "EXIF"},
		{"a huge picture claimed", b64(withSize(t, good, 60000, 60000)), "60000×60000, must be 428×270"},
		{"bad base64", "not*base64", "base64"},
		{"empty", "", "not a JPEG"},
	} {
		_, err := svc.SetPhoto(ctx, cardID, c.b64)
		if !errors.Is(err, ErrBadPhoto) || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v, want ErrBadPhoto saying %q", c.name, err, c.want)
		}
	}
	// The good one is still there.
	if _, got, _ := svc.Photo(ctx, cardID); got != tag {
		t.Fatalf("a refused photo replaced the kept one: %q", got)
	}

	if _, err := svc.SetPhoto(ctx, "NOT-AN-ID", b64(good)); !errors.Is(err, ErrBadID) {
		t.Fatalf("bad id: %v", err)
	}
	if err := svc.RemovePhoto(ctx, "NOT-AN-ID"); !errors.Is(err, ErrBadID) {
		t.Fatalf("bad id on remove: %v", err)
	}
	if _, _, err := svc.Photo(ctx, "NOT-AN-ID"); !errors.Is(err, ErrBadID) {
		t.Fatalf("bad id on read: %v", err)
	}
	if err := svc.RemovePhoto(ctx, cardID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Photo(ctx, cardID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("after remove: %v", err)
	}
}
