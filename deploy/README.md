# deploy/

What Karto Wallet uploads to `~/card-app/` on a new VM, plus the `cardd` binary as
`bin/cardd` (linux/amd64, built with `make cardd-linux`). The VM is a Debian one
from LNVPS; the person never logs in to it, the app does everything below.

| File | Job |
|---|---|
| `compose.yaml` | phoenixd, cardd, Caddy and ntfy. Images other than cardd are pinned by digest. |
| `Dockerfile.cardd` | Wraps `bin/cardd` and the VM's CA roots in a `scratch` image, `cardd:local`. |
| `Caddyfile` | TLS for `$CARDD_HOST`, proxied to cardd, and for `$CARDD_HOST:8443`, proxied to ntfy. |
| `ntfy/server.yml` | ntfy's settings: the phones' UnifiedPush server for alerts (below). No secrets. |
| `install.sh` | The install steps, each safe to re-run. |
| `cardd-ctl` | Runs a `cardd` command inside the running container. |
| `README.md` | This file. |

Not uploaded: `server-version.sh`, which prints the version `cardd` is stamped
with (the last commit that changed the server's code);
[`signing/`](signing/README.md), how the Android apps are signed; and `test/`,
the scripts behind the `Makefile`'s targets (the stack's test, the builds, and
the checks run on a real phone over adb).

The app runs these over SSH, in order:

```sh
~/card-app/install.sh first-boot             # wait for cloud-init to finish
~/card-app/install.sh swap                   # a 1 GiB swap file
~/card-app/install.sh docker                 # Docker and its compose plugin
~/card-app/install.sh docker-setup           # log caps, the docker group, image prune timer
                                             # (install.sh system runs these four in order)
~/card-app/install.sh prepare vm-1234.lnvps.cloud
~/card-app/install.sh seed        < 12 words # phoenixd seed, never replaced once set
~/card-app/install.sh issuer-key  < 32 hex   # cardd issuer key, never replaced once set
~/card-app/install.sh up                     # start, wait until healthy
~/card-app/cardd-ctl meta set vm.id 1234     # and vm.host, account.pubkey, backup.recipient, ...
~/card-app/cardd-ctl device add -pubkey <hex> -name "My phone"
```

Secrets go in on stdin, so they never sit in a file on the VM outside the
Docker volumes, except ntfy's write token for cardd, which `prepare` makes and
keeps in `.env`, readable only by the user (0600). `seed` and `issuer-key` exit 3 if a different value is already
there (the app reads that as "wrong recovery phrase"), and `up` exits 4 if
the seed has not been written, so phoenixd never makes its own. `cardd-ctl
device add` exits 5 if that key was revoked: the phone needs a new key.

**ntfy** (alerts with the app closed) is the
fourth service: the UnifiedPush server a Google-free phone's ntfy app keeps a
connection to, at `https://$CARDD_HOST:8443` (ntfy can't sit on a sub-path, and
LNVPS hostnames get no subdomains). Anyone may read an `up*` topic (its random
name is the secret, its messages are encrypted to the phone); only cardd may
write one, as the user `cardd` with an access token; nothing else is allowed
(`auth-default-access: deny-all`, no sign-up, login, web app or attachments).
cardd posts inside the stack, to `http://ntfy:80`, so an alert never leaves the
server until ntfy hands it to the phone. Its cache keeps a message 24 h for a
phone that is offline. `prepare` makes the token and the hash of a random
password (by ntfy's own `ntfy user hash`; the password is kept nowhere) once,
in `.env` as `NTFY_CARDD_TOKEN` and `NTFY_CARDD_HASH`, single-quoted so compose
leaves the hash's `$`s alone, and keeps them on every re-run. Nothing waits on
ntfy: if it is down, `:8443` answers 502 and the API on 443 carries on (but
`up` waits for its health like the others').

The app also records the bundle it installed (`cardd-ctl meta set
bundle.sha256 <hash>`; see `app/src/deploy/bundle.ts`), and `cardd`'s signed
`GET /api/v1/server` returns it, so the app can offer **Update server** when
it carries a newer bundle. An update re-runs every step above: each is safe
to repeat, and `up` replaces only the containers whose image changed.

**Rebuild server** adds steps on both servers.
On the one being replaced, if it answers over SSH:

```sh
~/card-app/install.sh final-snapshot         # prints {"version":N,"created":T}
~/card-app/install.sh retire 1235            # compose down, then the marker; prints "retired"
~/card-app/install.sh retired                # prints "<UTC time> 1235", or exits 1
```

`retired` exits 9 where there is no phoenixd seed at all (no Docker, no
phoenixd volume, or no `seed.dat` in it: never installed, or re-installed
through LNVPS).
Before `up`, the app asks it of the phrase's other VMs over SSH (its own
`install.sh` uploaded first), so that no other server runs phoenixd on the seed.

`retire` removes the containers (Docker would restart stopped ones when LNVPS
boots the VM) and writes `RETIRED` beside phoenixd's `seed.dat`; `up` then
exits 8 ("this server was retired (replaced by VM 1235)"), so neither a
re-install nor **Update server** starts a second phoenixd on the seed. On the
new server, the install above runs with two more steps:

```sh
~/card-app/install.sh wipe                   # in place only, after prepare
~/card-app/install.sh restore <pubkey hex> 1235 vm-1235.lnvps.cloud 203.0.113.171 0123abcd-2-1759750000 < base64 of cardd.db
~/card-app/install.sh restore-fresh <pubkey hex> 1235 vm-1235.lnvps.cloud 203.0.113.171   # instead, for the phrase alone
```

`wipe` stops everything and deletes `cardd.db` (with `-wal`, `-shm`),
`/data/backups` and all of phoenixd's volume but `seed.dat`, the marker
included; the issuer key stays. `restore` (after `issuer-key`, before `up`)
decodes the database into `cardd restore`, which re-activates the phone's key,
writes the new VM's id, hostname and IPv4 address (so `cardd`'s first snapshot
names this VM, before the `meta` step writes them again), marks the ledger
to be set to phoenixd's balance once the channel is back, and marks every
active or frozen card as needing a check: its counter is the backup's, so a
tap recorded after the backup would pass, and the card pays again only once
it has been held to the owner's phone (the wallet's tap check moves the
counter to the card's own); the optional last
argument is the backup's name, kept as `meta restore.from`. It exits 6 for a backup from a newer `cardd` and 7 if a
database it didn't restore is there; a repeat prints `already restored`.
`restore-fresh`, for the phrase alone, has no `cardd.db` to read: the person's
own notes on payments and the notes payers left with top-ups live only
there, so a server rebuilt that way has neither.

Before a rebuild relies on ACINQ giving the channel back, `make phone-recovery-check` has the app run,
on its paired server:

```sh
~/card-app/install.sh recovery-check [MINUTES]   # 15 by default; prints one JSON line
~/card-app/install.sh recovery-check result      # the last check's line, once it has ended
```

It refuses, touching nothing (exit 10), without a Normal channel, while a
payment is in progress (`cardd ledger holds` lists one) or on a retired
server. Otherwise it stops `cardd` and phoenixd, moves phoenixd's database
and logs into `aside-<UTC time>/` in its volume (`seed.dat`, `phoenix.conf`
and `RETIRED` stay), and starts phoenixd without them. A Normal channel, the
same one (by `channelIds`) with the same balance (to 1 sat), within MINUTES
keeps the new database, renames the old one `stale-<time>/` (never to be put
back: the new one may already be ahead of it) and prints
`{"ok":true,"before":…,"after":…,"at":…,"seconds":N}`. Otherwise it exits 9
with `{"ok":false,"reason":…}`: with no Normal channel, even at a last look
just before phoenixd stops, the new files go to `new-<time>/` and the old
ones are moved back exactly as they were (a channel that never came up made
no updates); a Normal channel with another balance or id keeps the new
database (with `"after"`). Nothing in phoenixd's volume is deleted, so
`stale-*` and `new-*` can be removed by hand once you no longer want them.
Everything is started again in every outcome, unless the server was retired
meanwhile: then nothing starts (exit 1). The work runs detached, logging to
`~/card-app/recovery-check.log`, so a dropped SSH session can't stop it half
done: the app's next try waits for it (`install.sh recovery-check` exits 11
while one runs, as `up`, `retire` and `wipe` do). If the phone's session
dropped, `make phone-recovery-check RESULT=1` only reads the last check's
result (`recovery-check result`), waiting for one that still runs: it never
starts a second check.

Its progress is in `~/card-app/recovery-check.state` (the stage it is at first),
written before each step. If a reboot or a kill cuts a check short, the next
`install.sh recovery-check` or `up` (and so **Update server**) finishes it by
the same rules before anything else, so `cardd` never starts on the new
database while the original is set aside: a Normal channel now keeps the new
one, otherwise the original goes back. If `up` or `recovery-check` instead
says `phoenixd's database is set aside in aside-… with no record of the
check` (or that the state is damaged), put it back by hand, after making sure
the new database never had a Normal channel (`docker compose logs phoenixd`).
Only the app holds the VM's SSH key, so these commands go through LNVPS's
web console for the VM (a check that was only cut short needs none of them:
the app's **Update server** finishes it, as its `up` does):

```sh
cd ~/card-app
docker compose stop phoenixd cardd
docker compose run --rm --no-deps -T --entrypoint sh phoenixd -c 'cd /phoenix/.phoenix && ls -lA . aside-*'
# with AT the aside directory's time, e.g. 20261007T101500Z:
docker compose run --rm --no-deps -T --entrypoint sh phoenixd -c 'cd /phoenix/.phoenix && AT=20261007T101500Z &&
  mkdir -p new-$AT && find . -mindepth 1 -maxdepth 1 ! -name seed.dat ! -name phoenix.conf ! -name RETIRED \
  ! -name "aside-*" ! -name "stale-*" ! -name "new-*" -exec mv {} new-$AT/ \; &&
  find aside-$AT -mindepth 1 -maxdepth 1 -exec mv -n {} . \; && rmdir aside-$AT'
rm -f recovery-check.state
./install.sh up
```

If the channel was Normal on the new database, keep it instead: `mv -T
aside-$AT stale-$AT` in the volume, then `up`. A retired server keeps its
databases as they are; nothing there needs finishing.

If `/health` reports `"alert": "spending paused"` and stays that way, the
books and phoenixd's balance disagree. Look first (`docker compose logs cardd
phoenixd`), then `~/card-app/cardd-ctl ledger reconcile` books the difference
to pool as a recorded `adjust` transaction, and spending starts again within a
minute. It first credits top-ups whose webhook was missed, does nothing when
the books add up, and refuses while a payment is in progress.

`make deploy-test` runs the whole sequence locally against a throwaway
compose project (`deploy/test/stack-test.sh`). The system steps (`first-boot`,
`swap`, `docker`, `docker-setup`; `system` runs the four) are only exercised on a real
Debian 13 VM; `deploy/test/install-system-test.sh` runs them with sudo stubbed.
