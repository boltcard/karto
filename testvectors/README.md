# Shared test vectors

`vectors.json` holds the sections `deterministic`, `sun`, `phrase` and
`deviceAuth`; the table's other rows are files of their own. It is read by both the Go tests (`server/internal/testvec`) and the
TypeScript tests (`app/src/testing/vectors.ts`). Change it only together with
both implementations.

| Section | Source |
|---|---|
| `deterministic` | The "Test vectors" section of boltcard `docs/DETERMINISTIC.md` |
| `sun[AN12196]` | The SUN example in NXP AN12196: K1 = K2 = zero key, UID `04de5f1eacc040`, counter 61 |
| `sun[deterministic-v1-ctr5]` | Built from the `deterministic` keys at counter 5, random bytes `0102030405` |
| `phrase` | Derived from the BIP-39 test phrase `abandon … about` with the paths in `app/src/keys/derive.ts` |
| `deviceAuth` | A fixed P-256 key; RFC 6979 deterministic DER signature over `canonical` |
| `age.json` | Files encrypted by filippo.io/age v1.3.2 to `phrase.backupAgeRecipient` (empty, 15 bytes, 65,537 and 131,072 bytes; byte i is i % 251), written by `CARDD_WRITE_AGE_VECTORS=1 go test -run TestAgeVectors ./internal/backup/` and checked by every run of it and by `app/src/backup/age.test.ts` |
| `schema.json` | `cardd`'s database schema version (`store.SchemaVersion()`), which the app pins to refuse a backup from a newer `cardd`; written by `CARDD_WRITE_SCHEMA=1 go test -run TestSchemaVector ./internal/store/` and checked by every run of it |
| `snapshot.db`, `snapshot.json` | A small snapshot as `cardd` takes one (`SnapshotTo`): active cards, one being added and one reset, money in cards, `pool`, `hosting` and `shop` (a sale's), a settled spend, an open hold and a card's photo; and its summary as `cardd`'s own functions read it (`vm.id`, `user_version`, cards not reset, `OwedMsat`, and `changed`, the time of its last write). Written by `CARDD_WRITE_SNAPSHOT=1 go test -run TestSnapshotVector ./internal/store/`, checked by every run of it (the summary, and that the schema is this `cardd`'s), and read with the app's summary SQL by `app/src/backup/summary.test.ts` |
| `phonecard.json` | A phone's card (the phone acting as a Bolt Card) under the issuer key `00…01`: the IDs of numbers 0 and 1 and the ids `cardd` lists them under, and number 0's taps at key version 0 for `lnurlw://vm-1.lnvps.cloud/ln`, each with the random bytes `0102030405`: a batch of 16 from counter 412345 and the first of the batch after it. Written by `PHONE_CARD_WRITE_VECTORS=1 npx vitest run src/phoneCard/taps.test.ts` in `app/`, checked by every run of `app/src/phoneCard/` and put to `cardd`'s own tap handler by `server/internal/lnurl/phonecard_test.go` |
| `alerts.json` | An alert's payload as `cardd` sends it and the title and text the phones must compose from it, for each case: top-ups of a card, the pool and hosting, sales (priced in the currency, also on a server with no currency set, and typed in sat), spends, no currency, £, €, $ and ¥, each refusal reason with and without an amount, a folded update (`"update": true`, counted in spends or, with no amount, taps), an hour's summary and the test alert. A refusal's `tag` is its card's 60 s window's, `refused-<card id>-<window start, Unix s>`, or an hour's summary's, `refused-<card id>-hour-<hour end, Unix s>`; `update` (omitted when false) marks a later count of a window's notification, to be updated silently. Rates: £250,000, €230,000, $270,000 and ¥45,000,000 a bitcoin, a minute old. Written from the table in `server/internal/alerts/payload_test.go` by `CARDD_WRITE_ALERT_VECTORS=1 go test -run TestPayloadsMatchVectors ./internal/alerts/`, checked by every run of it, and read for the words by the Android module's `AlertWordsTest.kt` |

The `phrase`, `sun[deterministic-v1-ctr5]` and `deviceAuth` values were
generated with @noble/@scure 2.4.0 and checked independently in
Go (go-bip39, btcd hdkeychain, filippo.io/age, x/crypto/ssh, crypto/ecdsa).
The official BIP-85 and NIP-06 vectors are checked in `app/src/keys/derive.test.ts`.
