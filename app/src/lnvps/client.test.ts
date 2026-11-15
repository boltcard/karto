import { describe, expect, it } from 'vitest';
import { getVmOrNull, LnvpsClient, LnvpsError, vatGuard } from './client';
import { FakeLnvps, fakeInvoice } from '../testing/fakeLnvps';
import { vectors } from '../testing/vectors';

const setup = () => {
  const fake = new FakeLnvps();
  const client = new LnvpsClient({ fetch: fake.http.fetch, nostrSecretKey: vectors.phrase.nostrPrivateKey });
  return { fake, client };
};

describe('LnvpsClient', () => {
  it('signs every authenticated request with the phrase Nostr key', async () => {
    const { fake, client } = setup();
    await client.getAccount();
    await client.getAccount(); // a fresh event each time, or the fake rejects it as reused
    expect(fake.pubkey).toBe(vectors.phrase.nostrPublicKey);
  });

  it('declares a country and reads it back', async () => {
    const { client } = setup();
    const account = await client.setCountry('GBR');
    expect(account.country_code).toBe('GBR');
    expect(vatGuard(account)).toEqual({ ok: true });
  });

  it('notices when LNVPS drops an unknown country code', async () => {
    const { client } = setup();
    await expect(client.setCountry('XYZ')).rejects.toThrow('did not accept the country code XYZ');
    await expect(client.setCountry('gb')).rejects.toThrow('alpha-3');
  });

  it('keeps other account fields and never sends tax when patching', async () => {
    const { fake, client } = setup();
    await client.setCountry('GBR');
    await client.updateAccount({ email: 'a@b.c' });
    expect(fake.account.country_code).toBe('GBR');
    const patch = fake.http.requests.filter((r) => r.method === 'PATCH').pop()!;
    expect(JSON.parse(patch.body!)).not.toHaveProperty('tax');
  });

  it('finds the x86_64 SSD template and the Debian 13 image', async () => {
    const { client } = setup();
    expect((await client.customTemplate()).id).toBe(7);
    expect((await client.debianImage()).id).toBe(6);
  });

  it('orders a VM, prices it and gets an invoice for its Lightning address', async () => {
    const { fake, client } = setup();
    fake.serverNow = () => 1_790_000_000_000; // the invoice carries the server's time
    fake.account.email_verified = true;
    const key = await client.addSshKey('card-app', vectors.phrase.sshAuthorizedKey);
    const vm = await client.orderVm(7, 6, key.id);
    expect(vm.expires).toBeNull();
    expect(await client.satPerDay(vm.id)).toBeCloseTo(6863 / 31, 6);
    expect(await client.vmInvoice(vm.id, 6863)).toBe(fakeInvoice(6_863_000n));
  });

  // The project's LNVPS referral code goes with every order (LNVPS's CustomVmOrder.ref_code).
  it('orders a VM with the project\'s referral code', async () => {
    const { fake, client } = setup();
    fake.account.email_verified = true;
    const key = await client.addSshKey('card-app', vectors.phrase.sshAuthorizedKey);
    await client.orderVm(7, 6, key.id);
    const order = fake.http.requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/v1/vm/custom-template'));
    expect(JSON.parse(order!.body!)).toMatchObject({ pricing_id: 7, image_id: 6, ssh_key_id: key.id, ref_code: 'pZl3J4BV' });
  });

  // LNVPS's own invoice (what its website pays), not the VM's Lightning address: one billing period.
  it('gets LNVPS\'s own Lightning invoice for one billing period', async () => {
    const { fake, client } = setup();
    fake.serverNow = () => 1_790_000_000_000;
    fake.account.email_verified = true;
    await client.setCountry('GBR'); // no VAT
    const key = await client.addSshKey('card-app', vectors.phrase.sshAuthorizedKey);
    const vm = await client.orderVm(7, 6, key.id);
    const p = await client.renewVm(vm.id);
    expect(p).toMatchObject({ vm_id: vm.id, amount: 6_863_000, tax: 0, time: 31 * 86400, is_paid: false, data: { lightning: fakeInvoice(6_863_000n) } });
    expect(Date.parse(p.expires)).toBe(1_790_000_000_000 + 600_000);
    expect(fake.http.requests.some((r) => r.url.endsWith(`/api/v1/vm/${vm.id}/renew?method=lightning&intervals=1`))).toBe(true);
  });

  it('still works when the phone clock is minutes off, using the server Date header', async () => {
    const fake = new FakeLnvps();
    let phone = Date.UTC(2026, 9, 3, 12, 0, 0);
    fake.serverNow = () => phone + 7 * 60_000; // the phone is 7 minutes slow
    const client = new LnvpsClient({ fetch: fake.http.fetch, nostrSecretKey: vectors.phrase.nostrPrivateKey, now: () => phone });
    await client.getAccount();
    phone += 1000;
    await client.getAccount(); // the offset is remembered: no failed attempt this time
    const statuses = fake.http.requests.filter((r) => r.url.endsWith('/account')).length;
    expect(statuses).toBe(3); // one rejected, then two accepted
  });

  // Seen on the phone: Android's HTTP stack resent a request on a dead kept-alive connection,
  // LNVPS had the first copy, and refused the second as a replay. Sign afresh and send again.
  it('signs again when the network delivered a request twice', async () => {
    const fake = new FakeLnvps();
    fake.account.email_verified = true;
    const plain = new LnvpsClient({ fetch: fake.http.fetch, nostrSecretKey: vectors.phrase.nostrPrivateKey });
    const key = await plain.addSshKey('card-app', vectors.phrase.sshAuthorizedKey);
    const vm = await plain.orderVm(7, 6, key.id);
    let doubled = false;
    const direct = new LnvpsClient({
      fetch: async (url, init) => {
        if (!doubled && url.endsWith(`/api/v1/vm/${vm.id}`)) {
          doubled = true;
          await fake.http.fetch(url, init); // the copy LNVPS got first; its answer was lost
        }
        return fake.http.fetch(url, init);
      },
      nostrSecretKey: vectors.phrase.nostrPrivateKey,
    });
    expect((await direct.getVm(vm.id)).id).toBe(vm.id);
    expect(doubled).toBe(true);
  });

  // A POST the server already acted on must not be sent again: that would order a second VM.
  it('does not send a refused POST again', async () => {
    const fake = new FakeLnvps();
    fake.account.email_verified = true;
    let doubled = false;
    const client = new LnvpsClient({
      fetch: async (url, init) => {
        if (!doubled && init?.method === 'POST' && url.endsWith('/api/v1/vm/custom-template')) {
          doubled = true;
          await fake.http.fetch(url, init);
        }
        return fake.http.fetch(url, init);
      },
      nostrSecretKey: vectors.phrase.nostrPrivateKey,
    });
    const key = await client.addSshKey('card-app', vectors.phrase.sshAuthorizedKey);
    await expect(client.orderVm(7, 6, key.id)).rejects.toThrow('already been used');
    expect(fake.vms.size).toBe(1);
  });

  // 40 s off is inside LNVPS's 60 s window, so the first copy was accepted and acted on,
  // yet far enough from the Date header to look like skew. Only a timestamp refusal proves it wasn't.
  it('does not send a refused POST again even when the phone clock looks off', async () => {
    const fake = new FakeLnvps();
    fake.account.email_verified = true;
    const phone = Date.UTC(2026, 9, 3, 12, 0, 0);
    fake.serverNow = () => phone + 40_000;
    let doubled = false;
    const client = new LnvpsClient({
      fetch: async (url, init) => {
        if (!doubled && init?.method === 'POST' && url.endsWith('/api/v1/vm/custom-template')) {
          doubled = true;
          await fake.http.fetch(url, init);
        }
        return fake.http.fetch(url, init);
      },
      nostrSecretKey: vectors.phrase.nostrPrivateKey,
      now: () => phone,
    });
    const key = await client.addSshKey('card-app', vectors.phrase.sshAuthorizedKey);
    await expect(client.orderVm(7, 6, key.id)).rejects.toThrow('already been used');
    expect(fake.vms.size).toBe(1);
  });

  it('sends a POST again after LNVPS refused its timestamp, which it does before acting on it', async () => {
    const fake = new FakeLnvps();
    const phone = Date.UTC(2026, 9, 3, 12, 0, 0);
    fake.serverNow = () => phone + 7 * 60_000;
    const client = new LnvpsClient({ fetch: fake.http.fetch, nostrSecretKey: vectors.phrase.nostrPrivateKey, now: () => phone });
    expect((await client.addSshKey('card-app', vectors.phrase.sshAuthorizedKey)).name).toBe('card-app');
  });

  it('gives up after one retry when the clock is not the problem', async () => {
    const fake = new FakeLnvps();
    const other = new LnvpsClient({ fetch: fake.http.fetch, nostrSecretKey: vectors.phrase.nostrPrivateKey });
    await other.getAccount();
    const client = new LnvpsClient({ fetch: fake.http.fetch, nostrSecretKey: '1'.repeat(64) });
    await expect(client.getAccount()).rejects.toThrow('wrong account');
  });

  // A rebuild starts a stopped old VM to retire it, or re-installs it as the last resort.
  it('starts and re-installs a VM, and reads when an expired one is deleted', async () => {
    const { fake, client } = setup();
    fake.serverNow = () => Date.UTC(2026, 9, 6, 12, 0, 0);
    fake.account.email_verified = true;
    const key = await client.addSshKey('card-app', vectors.phrase.sshAuthorizedKey);
    const vm = await client.orderVm(7, 6, key.id);
    fake.pay(vm.id);
    fake.boot(vm.id);
    fake.publishHostKeys(vm.id, [{ key_type: 'ssh-ed25519', public_key: 'AAAA', fingerprint_sha256: 'SHA256:x' }]);
    fake.stop(vm.id);
    await client.startVm(vm.id);
    expect((await client.getVm(vm.id)).status.state).toBe('running');
    await client.reinstallVm(vm.id);
    // Its disk is new: LNVPS captures the host keys again after the first boot.
    expect((await client.getVm(vm.id)).host_ssh_keys).toEqual([]);
    expect(fake.reinstalled).toEqual([vm.id]);
    expect(fake.http.requests.filter((r) => r.method === 'PATCH').map((r) => r.url)).toEqual([
      `https://api.lnvps.net/api/v1/vm/${vm.id}/start`,
      `https://api.lnvps.net/api/v1/vm/${vm.id}/re-install`,
    ]);
    fake.expire(vm.id, '2026-10-20T12:00:00Z');
    expect(await client.getVm(vm.id)).toMatchObject({ status: { state: 'stopped' }, deleting_on: '2026-10-20T12:00:00Z' });
    await expect(client.reinstallVm(vm.id)).rejects.toMatchObject({ status: 402 });
    expect(fake.reinstalled).toEqual([vm.id]);
  });

  it('reads a VM LNVPS deleted, or never had, as none', async () => {
    const { fake, client } = setup();
    fake.account.email_verified = true;
    const key = await client.addSshKey('card-app', vectors.phrase.sshAuthorizedKey);
    const vm = await client.orderVm(7, 6, key.id);
    expect((await getVmOrNull(client, vm.id))?.id).toBe(vm.id);
    expect(await getVmOrNull(client, 9999)).toBeNull();
    fake.deleteVm(vm.id);
    expect(await getVmOrNull(client, vm.id)).toBeNull();
    const broken = new LnvpsClient({ fetch: async () => new Response('busy', { status: 503 }), nostrSecretKey: vectors.phrase.nostrPrivateKey });
    await expect(getVmOrNull(broken, vm.id)).rejects.toMatchObject({ status: 503 });
  });

  it('turns API errors into LnvpsError with the status', async () => {
    const { client } = setup();
    const err = await client.orderVm(7, 6, 1).catch((e) => e);
    expect(err).toBeInstanceOf(LnvpsError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('Email must be verified');
  });
});

describe('vatGuard', () => {
  const acct = (rate: number, treatment: string) => ({ tax: [{ company_id: 1, company_name: 'LNVPS', rate, treatment, country_code: 'IRL' }] });
  it('passes only at 0% out_of_scope', () => {
    expect(vatGuard(acct(0, 'out_of_scope'))).toEqual({ ok: true });
    expect(vatGuard(acct(23, 'domestic'))).toEqual({ ok: false, message: 'LNVPS would charge 23% VAT (domestic, IRL)' });
    expect(vatGuard(acct(0, 'undetermined_default')).ok).toBe(false);
    expect(vatGuard({}).ok).toBe(false);
  });
});
