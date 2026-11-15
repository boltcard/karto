package cards

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image/jpeg"
)

// A card's photo: the thumbnail the phone
// makes, never processed here, only checked.
const (
	PhotoWidth    = 428
	PhotoHeight   = 270
	MaxPhotoBytes = 64 << 10
)

var ErrBadPhoto = errors.New("cards: a photo is a 428×270 JPEG of at most 64 KB, without EXIF")

// SetPhoto keeps a card's photo, given as base64, and answers its tag
// (store.PhotoTag). store.ErrNotFound for an unknown card, store.ErrConflict
// for a wiped one.
func (s *Service) SetPhoto(ctx context.Context, id, b64 string) (string, error) {
	if !idPattern.MatchString(id) {
		return "", ErrBadID
	}
	b, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", fmt.Errorf("%w: it isn't base64: %v", ErrBadPhoto, err)
	}
	if err := checkPhoto(b); err != nil {
		return "", err
	}
	return s.store.SetPhoto(ctx, id, b)
}

// RemovePhoto removes a card's photo; none is fine.
func (s *Service) RemovePhoto(ctx context.Context, id string) error {
	if !idPattern.MatchString(id) {
		return ErrBadID
	}
	return s.store.RemovePhoto(ctx, id)
}

// Photo returns a card's photo and its tag; store.ErrNotFound without one.
func (s *Service) Photo(ctx context.Context, id string) ([]byte, string, error) {
	if !idPattern.MatchString(id) {
		return nil, "", ErrBadID
	}
	return s.store.GetPhoto(ctx, id)
}

// PhotoTags returns each card's photo tag, by card id.
func (s *Service) PhotoTags(ctx context.Context) (map[string]string, error) {
	return s.store.PhotoTags(ctx)
}

// checkPhoto refuses anything but a whole 428×270 JPEG of at most 64 KB
// without EXIF. The header is read first, so a small file that claims a huge
// picture is refused before anything decodes it.
func checkPhoto(b []byte) error {
	if len(b) > MaxPhotoBytes {
		return fmt.Errorf("%w: it is %d bytes, at most %d", ErrBadPhoto, len(b), MaxPhotoBytes)
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return fmt.Errorf("%w: not a JPEG: %v", ErrBadPhoto, err)
	}
	if cfg.Width != PhotoWidth || cfg.Height != PhotoHeight {
		return fmt.Errorf("%w: it is %d×%d, must be %d×%d", ErrBadPhoto, cfg.Width, cfg.Height, PhotoWidth, PhotoHeight)
	}
	if hasEXIF(b) {
		return fmt.Errorf("%w: it carries EXIF (an APP1 segment)", ErrBadPhoto)
	}
	if _, err := jpeg.Decode(bytes.NewReader(b)); err != nil {
		return fmt.Errorf("%w: it doesn't decode: %v", ErrBadPhoto, err)
	}
	return nil
}

// hasEXIF reports whether a JPEG has an APP1 segment (EXIF, or XMP) before
// its scan. It walks the marker segments from SOI; a malformed run of them
// stops the walk, and the full decode refuses the file then.
func hasEXIF(b []byte) bool {
	for i := 2; i+1 < len(b); {
		if b[i] != 0xff {
			return false
		}
		marker := b[i+1]
		switch {
		case marker == 0xff: // fill byte
			i++
			continue
		case marker == 0xda: // start of scan: no more headers
			return false
		case marker == 0x01 || (marker >= 0xd0 && marker <= 0xd9): // no length
			i += 2
			continue
		case marker == 0xe1:
			return true
		}
		if i+3 >= len(b) {
			return false
		}
		i += 2 + int(b[i+2])<<8 + int(b[i+3])
	}
	return false
}
