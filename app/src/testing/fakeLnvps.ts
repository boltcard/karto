// A stateful stand-in for api.lnvps.net that checks every NIP-98 signature.
// It models what the onboarding flow depends on, as observed on the real API
// (2026-10-02): unknown countries saved as null, VAT by
// country, email verification by link, orders needing a verified email.
import { bech32 } from '@scure/base';
import { FakeHttp, HttpError } from './http';
import { verifyNip98Header } from '../nostr/nip98';
import type { Account, HostKey, Vm } from '../lnvps/client';

const API = 'https://api.lnvps.net';
const KNOWN_COUNTRIES = ['GBR', 'IRL', 'DEU', 'USA', 'FRA'];
const VAT: Record<string, [number, string]> = { GBR: [0, 'out_of_scope'], USA: [0, 'out_of_scope'], IRL: [23, 'domestic'], DEU: [19, 'oss_b2c'], FRA: [20, 'oss_b2c'] };

/** A BOLT11 invoice that decodes (amount, timestamp, expiry); its signature is zeros. */
export function fakeInvoice(msat: bigint, timestampS = 1_790_000_000, expiryS = 600): string {
  const int = (n: number, len: number) => Array.from({ length: len }, (_, i) => Math.floor(n / 32 ** (len - 1 - i)) % 32);
  const expiry = int(expiryS, 2);
  const words = [...int(timestampS, 7), 6, ...int(expiry.length, 2), ...expiry, ...new Array(104).fill(0)];
  return bech32.encode(`lnbc${msat / 100n}n`, words, false);
}

export class FakeLnvps {
  readonly http = new FakeHttp();
  account: Account = { contact_nip17: false, contact_email: false, account_type: 'nostr' };
  pubkey?: string;
  sshKeys: { id: number; name: string; key_data: string }[] = [];
  vms = new Map<number, Vm>();
  invoices: { vmId: number; msat: bigint; pr: string }[] = [];
  /** LNVPS's own clock (ms). It rejects NIP-98 events more than 60 s from it, and sends it as Date. */
  serverNow = () => Date.now();
  /** Called with (address, verification link) whenever the account email changes. */
  onVerificationEmail: (address: string, link: string) => void = () => {};
  /** Every token verify-email was asked, in order, recorded before it answers. */
  verifyCalls: string[] = [];
  /** Set: verify-email answers this status (429, 503…) whatever the token. */
  verifyStatus?: number;
  /** renew-lnurlp's status, when set: 429 is LNVPS's limit of about five invoices a minute for a VM. */
  invoiceStatus?: number;
  /** verify-email's status for one token (verifyStatus, when set, wins). */
  verifyStatusFor = new Map<string, number>();
  /** Tokens of other accounts: verify-email answers 200 and this account stays unverified. */
  foreignTokens = new Set<string>();
  /**
   * LNVPS's renewal quote enforces max_prepay_days (365): once a VM is paid
   * further ahead, it refuses (the Lightning-address route doesn't). Set to refuse.
   */
  quoteRefused = false;
  /**
   * The country of a VAT number on the account (set on LNVPS's website, never by the app): it decides the place of
   * supply over the declared country, as LNVPS's place_of_supply. Ireland's is taxed (domestic), the rest not.
   */
  vatNumberCountry?: string;
  /** Ids of VMs LNVPS deleted; asking for one again gives 409, as the API docs say. */
  deleted = new Set<number>();
  /** Ids of VMs re-installed (PATCH /re-install), in order. */
  reinstalled: number[] = [];
  private nextId = 1001;
  private tokens = new Map<string, true>();
  private seen = new Set<string>();

  constructor() {
    const h = this.http;
    h.date = () => new Date(this.serverNow()).toUTCString();
    const auth = (method: string) => ({ url, init, body }: { url: URL; init: RequestInit; body: string | undefined }) => {
      const header = (init.headers as Record<string, string>).authorization;
      if (!header) throw new HttpError(401, 'missing auth');
      const e = verifyNip98Header(header, url.toString(), method, body);
      if (Math.abs(e.created_at - this.serverNow() / 1000) > 60) throw new HttpError(401, 'Auth check failed: Created timestamp is out of range');
      if (this.seen.has(e.id)) throw new HttpError(401, 'Auth check failed: Credential has already been used');
      this.seen.add(e.id);
      if (this.pubkey && e.pubkey !== this.pubkey) throw new HttpError(403, 'wrong account');
      this.pubkey = e.pubkey;
    };
    const signed = (method: string, fn: (r: { url: URL; init: RequestInit; body: string | undefined }) => unknown) =>
      (r: { url: URL; init: RequestInit; body: string | undefined }) => {
        auth(method)(r);
        return { data: fn(r) ?? null };
      };

    h.on('GET', `${API}/api/v1/account`, signed('GET', () => ({ ...this.account, tax: this.tax() })));
    h.on('PATCH', `${API}/api/v1/account`, signed('PATCH', ({ body }) => {
      const next = JSON.parse(body!) as Account;
      if ('tax' in next) throw new HttpError(400, 'tax is read-only');
      const country = next.country_code && KNOWN_COUNTRIES.includes(next.country_code) ? next.country_code : null;
      const emailChanged = next.email !== this.account.email;
      this.account = { ...next, country_code: country, email_verified: emailChanged ? false : this.account.email_verified };
      if (emailChanged && next.email) {
        const token = `tok${this.tokens.size + 1}`;
        this.tokens.set(token, true);
        this.onVerificationEmail(next.email, `${API}/api/v1/account/verify-email?token=${token}`);
      }
    }));
    h.on('GET', `${API}/api/v1/account/verify-email`, ({ url }) => {
      const token = url.searchParams.get('token') ?? '';
      this.verifyCalls.push(token);
      const status = this.verifyStatus ?? this.verifyStatusFor.get(token);
      if (status !== undefined) throw new HttpError(status, 'verify-email unavailable');
      if (this.foreignTokens.has(token)) return { data: null };
      if (!this.tokens.has(token)) throw new HttpError(400, 'bad token');
      this.account.email_verified = true;
      return { data: null };
    });
    h.on('GET', `${API}/api/v1/ssh-key`, signed('GET', () => this.sshKeys.map(({ id, name }) => ({ id, name, created: '2026-10-03T00:00:00Z' }))));
    h.on('POST', `${API}/api/v1/ssh-key`, signed('POST', ({ body }) => {
      const { name, key_data } = JSON.parse(body!);
      const key = { id: this.sshKeys.length + 1, name, key_data };
      this.sshKeys.push(key);
      return { id: key.id, name, created: '2026-10-03T00:00:00Z' };
    }));
    h.on('GET', `${API}/api/v1/vm/templates`, () => ({
      data: {
        templates: [],
        custom_template: [
          { id: 3, name: 'arm', region: { name: 'Dublin' }, cpu_arch: 'arm64', disks: [{ disk_type: 'ssd', disk_interface: 'pcie' }] },
          { id: 7, name: 'main_2026_2', region: { name: 'Dublin' }, cpu_arch: null, disks: [{ disk_type: 'ssd', disk_interface: 'pcie' }, { disk_type: 'hdd', disk_interface: 'sata' }] },
        ],
      },
    }));
    h.on('GET', `${API}/api/v1/image`, () => ({
      data: [
        { id: 5, distribution: 'debian', version: '12', cpu_arch: 'x86_64', default_username: 'debian' },
        { id: 6, distribution: 'debian', version: '13', cpu_arch: 'x86_64', default_username: 'debian' },
      ],
    }));
    h.on('POST', `${API}/api/v1/vm/custom-template`, signed('POST', ({ body }) => {
      if (!this.account.email_verified) throw new HttpError(400, 'Email must be verified to create a VM');
      const order = JSON.parse(body!);
      if (order.pricing_id !== 7 || order.image_id !== 6) throw new HttpError(400, 'unexpected template or image');
      if (!this.sshKeys.some((k) => k.id === order.ssh_key_id)) throw new HttpError(400, 'unknown ssh key');
      const vm: Vm = {
        id: this.nextId++, created: new Date(this.serverNow()).toISOString(), expires: null, status: { state: 'unknown' },
        ip_assignments: [], host_ssh_keys: [], image: { default_username: 'debian' }, ssh_key: { id: order.ssh_key_id },
      };
      this.vms.set(vm.id, vm);
      return vm;
    }));
    h.on('GET', `${API}/api/v1/vm`, signed('GET', () => (this.expireUnpaid(), [...this.vms.values()])));
    h.on('GET', /^https:\/\/api\.lnvps\.net\/api\/v1\/vm\/\d+$/, signed('GET', ({ url }) => this.vm(url)));
    h.on('PATCH', /^https:\/\/api\.lnvps\.net\/api\/v1\/vm\/\d+\/start$/, signed('PATCH', ({ url }) => {
      this.vm(url).status = { state: 'running' };
    }));
    h.on('PATCH', /^https:\/\/api\.lnvps\.net\/api\/v1\/vm\/\d+\/re-install$/, signed('PATCH', ({ url }) => {
      const vm = this.vm(url);
      if (vm.expires && Date.parse(vm.expires) < this.serverNow()) throw new HttpError(402, 'VM is expired, renew it first');
      // A new disk: LNVPS captures the host keys again after its first boot.
      vm.host_ssh_keys = [];
      this.reinstalled.push(vm.id);
    }));
    h.on('GET', /^https:\/\/api\.lnvps\.net\/api\/v1\/vm\/\d+\/renew\/quote$/, signed('GET', ({ url }) => {
      this.vm(url);
      if (this.quoteRefused) throw new HttpError(400, 'Cannot renew more than 365 days in advance');
      // 6,863 sat for 31 days, the real price observed on 2026-10-02, plus the account's VAT.
      const amount = 6_863_000;
      return { amount, tax: Math.round((amount * this.tax()[0].rate) / 100), processing_fee: 0, currency: 'BTC', time: 31 * 86400 };
    }));
    h.on('GET', /^https:\/\/api\.lnvps\.net\/api\/v1\/vm\/\d+\/renew$/, signed('GET', ({ url }) => {
      const vmId = this.vm(url).id;
      const now = this.serverNow();
      const amount = 6_863_000; // one 31-day period, as the quote
      const tax = Math.round((amount * this.tax()[0].rate) / 100);
      const pr = fakeInvoice(BigInt(amount + tax), Math.floor(now / 1000));
      this.invoices.push({ vmId, msat: BigInt(amount + tax), pr });
      return {
        id: '00'.repeat(32), vm_id: vmId, created: new Date(now).toISOString(), expires: new Date(now + 600_000).toISOString(),
        amount, tax, processing_fee: 0, currency: 'BTC', is_paid: false, data: { lightning: pr }, time: 31 * 86400,
      };
    }));
    h.on('GET', /^https:\/\/api\.lnvps\.net\/\.well-known\/lnurlp\/\d+$/, ({ url }) => {
      const id = Number(url.pathname.split('/').pop());
      if (!this.vms.has(id)) throw new HttpError(404, 'VM not found');
      return { callback: `${API}/api/v1/vm/${id}/renew-lnurlp`, maxSendable: 1_000_000_000, minSendable: 100_000, tag: 'payRequest', metadata: `[["text/plain","Extend VM ${id}"]]` };
    });
    h.on('GET', /^https:\/\/api\.lnvps\.net\/api\/v1\/vm\/\d+\/renew-lnurlp$/, ({ url }) => {
      const vmId = Number(url.pathname.split('/')[4]);
      if (this.invoiceStatus !== undefined) throw new HttpError(this.invoiceStatus, 'Rate limit exceeded');
      const msat = BigInt(url.searchParams.get('amount') ?? '0');
      const pr = fakeInvoice(msat, Math.floor(this.serverNow() / 1000));
      this.invoices.push({ vmId, msat, pr });
      return { pr, routes: [] };
    });
  }

  private vm(url: URL): Vm {
    this.expireUnpaid();
    const id = Number(url.pathname.split('/')[4]);
    if (this.deleted.has(id)) throw new HttpError(409, 'VM is deleted');
    const vm = this.vms.get(id);
    if (!vm) throw new HttpError(404, 'VM not found');
    return vm;
  }

  /** LNVPS deletes an order that is still unpaid an hour after it was made. */
  private expireUnpaid() {
    for (const vm of this.vms.values()) {
      if (!vm.expires && this.serverNow() - Date.parse(vm.created) > 3600_000) this.deleteVm(vm.id);
    }
  }

  private tax() {
    const v = this.vatNumberCountry;
    if (v) return [{ company_id: 1, company_name: 'LNVPS', rate: v === 'IRL' ? 23 : 0, treatment: v === 'IRL' ? 'domestic' : 'reverse_charge', country_code: v }];
    const [rate, treatment] = VAT[this.account.country_code ?? ''] ?? [23, 'undetermined_default'];
    return [{ company_id: 1, company_name: 'LNVPS', rate, treatment, country_code: this.account.country_code ?? 'IRL' }];
  }

  // ---- test controls: what LNVPS does on its own ----
  /** The last invoice for this VM was paid. */
  pay(vmId: number) {
    const vm = this.vms.get(vmId)!;
    vm.expires = '2026-11-02T12:00:00Z';
    vm.status = { state: 'creating' };
  }
  boot(vmId: number, ipv4 = '45.67.89.164') {
    const vm = this.vms.get(vmId)!;
    vm.status = { state: 'running' };
    vm.ip_assignments = [{ ip: `${ipv4}/24`, forward_dns: `vm-${vmId}.lnvps.cloud` }, { ip: '2a13:2c0::1/64' }];
  }
  publishHostKeys(vmId: number, keys: HostKey[]) {
    this.vms.get(vmId)!.host_ssh_keys = keys;
  }
  stop(vmId: number) {
    this.vms.get(vmId)!.status = { state: 'stopped' };
  }
  /** Unpaid past its expiry: stopped, and deleted on deletingOn unless renewed. */
  expire(vmId: number, deletingOn: string) {
    const vm = this.vms.get(vmId)!;
    vm.expires = new Date(this.serverNow() - 86400_000).toISOString();
    vm.deleting_on = deletingOn;
    vm.status = { state: 'stopped' };
  }
  /** An unpaid order is deleted after an hour. */
  deleteVm(vmId: number) {
    this.vms.delete(vmId);
    this.deleted.add(vmId);
  }
}
