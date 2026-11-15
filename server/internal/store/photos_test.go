package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

// Card photos: one thumbnail per card, in a
// table of its own; a wiped card keeps it but can't change it.
func TestPhotos(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	now := time.Unix(1_790_000_000, 0)
	s.now = func() time.Time { return now }
	activeCard(t, s, id)
	const other = "f0000000000000000000000000000001"
	activeCard(t, s, other)

	if _, _, err := s.GetPhoto(ctx, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("no photo yet: got %v, want ErrNotFound", err)
	}
	if tags, err := s.PhotoTags(ctx); err != nil || len(tags) != 0 {
		t.Fatalf("no photos: %v %v", tags, err)
	}

	now = now.Add(time.Minute)
	tag, err := s.SetPhoto(ctx, id, []byte("jpeg one"))
	if err != nil || tag != PhotoTag([]byte("jpeg one")) || len(tag) != 16 {
		t.Fatalf("set: %q %v", tag, err)
	}
	// Setting a photo is a change to the card: a snapshot's summary dates its
	// last write by the cards' updated_at (app/src/backup/summary.ts).
	if c, _ := s.GetCard(ctx, id); c.UpdatedAt.Unix() != now.Unix() {
		t.Fatalf("updated_at %d, want %d", c.UpdatedAt.Unix(), now.Unix())
	}
	jpeg, got, err := s.GetPhoto(ctx, id)
	if err != nil || !bytes.Equal(jpeg, []byte("jpeg one")) || got != tag {
		t.Fatalf("get: %q %q %v", jpeg, got, err)
	}

	// Replacing it changes the tag and dates the card; setting the same one
	// again is fine and changes nothing, the card's date included.
	now = now.Add(time.Minute)
	tag2, err := s.SetPhoto(ctx, id, []byte("jpeg two"))
	if err != nil || tag2 == tag {
		t.Fatalf("replace: %q %v", tag2, err)
	}
	if c, _ := s.GetCard(ctx, id); c.UpdatedAt.Unix() != now.Unix() {
		t.Fatalf("a replacement didn't date the card: %d, want %d", c.UpdatedAt.Unix(), now.Unix())
	}
	replaced := now
	now = now.Add(time.Minute)
	if again, err := s.SetPhoto(ctx, id, []byte("jpeg two")); err != nil || again != tag2 {
		t.Fatalf("same again: %q %v", again, err)
	}
	if c, _ := s.GetCard(ctx, id); c.UpdatedAt.Unix() != replaced.Unix() {
		t.Fatalf("the same photo again moved updated_at to %d, want %d", c.UpdatedAt.Unix(), replaced.Unix())
	}
	if tags, _ := s.PhotoTags(ctx); len(tags) != 1 || tags[id] != tag2 {
		t.Fatalf("tags: %v", tags)
	}

	// Removing it; removing none is fine, and doesn't touch the card.
	now = now.Add(time.Minute)
	if err := s.RemovePhoto(ctx, id); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.GetPhoto(ctx, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("after remove: %v", err)
	}
	if c, _ := s.GetCard(ctx, id); c.UpdatedAt.Unix() != now.Unix() {
		t.Fatalf("remove didn't date the card: %d", c.UpdatedAt.Unix())
	}
	now = now.Add(time.Minute)
	if err := s.RemovePhoto(ctx, id); err != nil {
		t.Fatalf("remove none: %v", err)
	}
	if c, _ := s.GetCard(ctx, id); c.UpdatedAt.Unix() == now.Unix() {
		t.Fatal("removing no photo changed the card")
	}

	// An unknown card: not found, never a foreign-key error.
	const unknown = "00000000000000000000000000000009"
	if _, err := s.SetPhoto(ctx, unknown, []byte("x")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("set unknown: %v", err)
	}
	if err := s.RemovePhoto(ctx, unknown); !errors.Is(err, ErrNotFound) {
		t.Fatalf("remove unknown: %v", err)
	}
	if _, _, err := s.GetPhoto(ctx, unknown); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get unknown: %v", err)
	}

	// A wiped card keeps its photo, and refuses a new one or a removal.
	if _, err := s.SetPhoto(ctx, other, []byte("other's")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.StartWipe(ctx, other); err != nil {
		t.Fatal(err)
	}
	if _, err := s.FinishWipe(ctx, other); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetPhoto(ctx, other, []byte("new")); !errors.Is(err, ErrConflict) {
		t.Fatalf("set on a wiped card: %v", err)
	}
	if err := s.RemovePhoto(ctx, other); !errors.Is(err, ErrConflict) {
		t.Fatalf("remove on a wiped card: %v", err)
	}
	if jpeg, _, err := s.GetPhoto(ctx, other); err != nil || string(jpeg) != "other's" {
		t.Fatalf("a wiped card's photo: %q %v", jpeg, err)
	}
	// Added again, it still has it.
	if _, err := s.ReserveCard(ctx, other, "Again", ""); err != nil {
		t.Fatal(err)
	}
	if tags, _ := s.PhotoTags(ctx); tags[other] != PhotoTag([]byte("other's")) {
		t.Fatalf("tags after adding again: %v", tags)
	}
}

// A snapshot is a copy of the whole database, so it carries the photos, and
// a restored copy reads them back.
func TestASnapshotCarriesThePhotos(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	activeCard(t, s, id)
	tag, err := s.SetPhoto(ctx, id, []byte{0xff, 0xd8, 1, 2, 3})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "snap.db")
	if err := s.SnapshotTo(ctx, path); err != nil {
		t.Fatal(err)
	}
	r, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	jpeg, got, err := r.GetPhoto(ctx, id)
	if err != nil || got != tag || !bytes.Equal(jpeg, []byte{0xff, 0xd8, 1, 2, 3}) {
		t.Fatalf("restored photo: %x %q %v", jpeg, got, err)
	}
}

// Migration 5 adds the table to a database made by the cardd before it.
func TestMigrationFiveOnASchemaFourDatabase(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range migrations[:4] {
		if _, err := db.Exec(m); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`PRAGMA user_version = 4;
		INSERT INTO cards (id, version, state, last_counter, name, created_at, updated_at) VALUES ('` + id + `', 0, 'active', 1, 'Old', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if v, _ := s.UserVersion(ctx); v != SchemaVersion() {
		t.Fatalf("user_version %d, want %d", v, SchemaVersion())
	}
	if _, err := s.SetPhoto(ctx, id, []byte("after the migration")); err != nil {
		t.Fatal(err)
	}
}
