// LNVPS API client. Every authenticated
// call is signed with NIP-98 by the account's Nostr key.
import { nip98Header } from '../nostr/nip98';
import { lnurlPayInvoice, type FetchFn } from '../lightning/lightning';

export const LNVPS_API = 'https://api.lnvps.net';

// The cheapest custom VM: 1 vCPU, 1 GiB RAM, 10 GiB SSD.
const GiB = 1024 ** 3;
export const VM_SPEC = { cpu: 1, memory: 1 * GiB, disk: 10 * GiB, disk_type: 'ssd', disk_interface: 'pcie' } as const;

// The project's LNVPS referral code, sent with every order (CustomVmOrder.ref_code in LNVPS's
// API_DOCUMENTATION.md; its provisioner records it on the VM unless it is the ordering account's own).
// The website's form of it: https://lnvps.net/?ref=pZl3J4BV
export const LNVPS_REF_CODE = 'pZl3J4BV';

export type TaxInfo = { company_id: number; company_name: string; rate: number; country_code?: string; treatment: string };
export type Account = {
  email?: string;
  email_verified?: boolean;
  country_code?: string | null;
  tax?: TaxInfo[];
  [field: string]: unknown;
};
export type HostKey = { key_type: string; public_key: string; fingerprint_sha256: string };
export type Vm = {
  id: number;
  created: string;
  expires?: string | null;
  status: { state: 'unknown' | 'running' | 'stopped' | 'creating' };
  /** When LNVPS deletes an expired VM unless it is renewed (expiry plus a grace of 1–14 days); none before it is paid. */
  deleting_on?: string | null;
  ip_assignments: { ip: string; forward_dns?: string }[];
  host_ssh_keys: HostKey[];
  image: { default_username?: string };
  ssh_key: { id: number };
  cpu_arch?: string;
};
export type RenewalQuote = { amount: number; tax: number; processing_fee: number; currency: string; time: number };
/** A payment LNVPS made for a VM (amount, tax and fee in millisats; time in seconds). */
export type VmPayment = {
  id: string;
  vm_id: number;
  created: string;
  expires: string;
  amount: number;
  tax: number;
  processing_fee: number;
  currency: string;
  is_paid: boolean;
  data: { lightning?: string };
  time: number;
};

export class LnvpsError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type VatCheck = { ok: true } | { ok: false; message: string };

/**
 * Whether LNVPS's VAT (the account's `tax`, one entry per selling company) is what the person chose: no VAT, or the
 * VAT of the country they declared. What it guards against is VAT by accident: LNVPS taxes by the declared country,
 * else the IP country (rewritten on every account change and order), else Ireland's rate as `undetermined_default`
 * (lnvps_api_common/src/pricing.rs, place_of_supply and determine_tax). The rate itself is LNVPS's: its quote, and so
 * the price of a day every payment is sized by (satPerDay), already includes it, and a Lightning-address payment is
 * taken as gross (get_cost_by_amount).
 */
export function vatGuard(account: Account): VatCheck {
  const entries = account.tax ?? [];
  if (entries.length === 0) return { ok: false, message: 'LNVPS returned no tax information for this account' };
  const declared = account.country_code?.toUpperCase();
  for (const t of entries) {
    if (typeof t.rate !== 'number' || !Number.isFinite(t.rate)) return { ok: false, message: `LNVPS returned a VAT rate the app can't read (${t.treatment})` };
    if (t.rate === 0 && t.treatment !== 'undetermined_default') continue;
    const where = t.country_code?.toUpperCase();
    const taxed = `LNVPS would charge ${t.rate}% VAT`;
    if (t.treatment === 'undetermined_default') return { ok: false, message: `${taxed} because it doesn't know your country (${t.treatment})` };
    if (!declared) return { ok: false, message: `${taxed} for ${where ?? 'no country'} (${t.treatment}) without your country declared` };
    if (where !== declared) {
      return { ok: false, message: `${taxed} for ${where ?? 'no country'} (${t.treatment}), not for your country, ${declared}: check your account on LNVPS` };
    }
    if (t.treatment !== 'domestic' && t.treatment !== 'oss_b2c') return { ok: false, message: `${taxed} for ${where} on terms the app doesn't know (${t.treatment})` };
  }
  return { ok: true };
}

export class LnvpsClient {
  /** Server clock minus phone clock (ms), learnt from a Date header after a rejected signature. */
  private clockOffsetMs = 0;

  constructor(
    private readonly opts: { fetch: FetchFn; nostrSecretKey: string; baseUrl?: string; now?: () => number },
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** LNVPS's clock (ms), as best known: the phone clock plus any offset learnt from a Date header. */
  serverTime(): number {
    return this.now() + this.clockOffsetMs;
  }

  private get base() {
    return this.opts.baseUrl ?? LNVPS_API;
  }

  private async api<T>(method: string, path: string, { body, auth = true }: { body?: unknown; auth?: boolean } = {}): Promise<T> {
    const url = this.base + path;
    const json = body === undefined ? undefined : JSON.stringify(body);
    const send = () => {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (json !== undefined) headers['content-type'] = 'application/json';
      if (auth) {
        const createdAt = Math.floor((this.now() + this.clockOffsetMs) / 1000);
        headers.authorization = nip98Header(this.opts.nostrSecretKey, url, method, json, { createdAt });
      }
      return this.opts.fetch(url, { method, headers, body: json });
    };
    let res = await send();
    let text: string | undefined;
    if (auth && res.status === 401) {
      // LNVPS rejects events more than 60 s from its clock, and phone clocks
      // drift: if the server's Date header is well away from ours, sign again
      // on the server's time. And Android's HTTP stack can resend a request on
      // a dead kept-alive connection, so LNVPS sees our event twice and refuses
      // the copy: each send signs a fresh event, so send again. Once, and a
      // POST only when LNVPS refused its timestamp: it checks that before
      // acting, while a refused copy means it may have acted on the first (a
      // second order), even if our clock also looks off.
      const serverMs = Date.parse(res.headers.get('date') ?? '');
      const offset = serverMs - this.now();
      const skewed = Number.isFinite(serverMs) && Math.abs(offset - this.clockOffsetMs) > 30_000;
      text = await res.text();
      const replayed = /already been used/i.test(text);
      const staleTimestamp = /timestamp is out of range/i.test(text);
      if (skewed) this.clockOffsetMs = offset;
      if (method === 'POST' ? staleTimestamp && skewed : skewed || replayed) {
        res = await send();
        text = undefined;
      }
    }
    text ??= await res.text();
    let parsed: { data?: T; error?: string };
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new LnvpsError(res.status, `${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.ok || parsed.error) throw new LnvpsError(res.status, `${method} ${path} → ${parsed.error ?? `HTTP ${res.status}`}`);
    return parsed.data as T;
  }

  getAccount(): Promise<Account> {
    return this.api('GET', '/api/v1/account');
  }

  /** PATCH takes the whole account, so read it, change fields, send it back without `tax`. */
  async updateAccount(changes: Partial<Account>): Promise<void> {
    const { tax: _tax, ...account } = await this.getAccount();
    await this.api('PATCH', '/api/v1/account', { body: { ...account, ...changes } });
  }

  /** Declares the country (ISO alpha-3). LNVPS silently stores an unknown code as null, so read it back. */
  async setCountry(alpha3: string): Promise<Account> {
    if (!/^[A-Z]{3}$/.test(alpha3)) throw new LnvpsError(400, `country must be an ISO alpha-3 code, got "${alpha3}"`);
    await this.updateAccount({ country_code: alpha3 });
    const account = await this.getAccount();
    if (account.country_code !== alpha3) throw new LnvpsError(400, `LNVPS did not accept the country code ${alpha3}`);
    return account;
  }

  listSshKeys(): Promise<{ id: number; name: string }[]> {
    return this.api('GET', '/api/v1/ssh-key');
  }

  addSshKey(name: string, keyData: string): Promise<{ id: number; name: string }> {
    return this.api('POST', '/api/v1/ssh-key', { body: { name, key_data: keyData } });
  }

  /** The custom template with an SSD on PCIe, on x86_64 (cardd is an amd64 binary). */
  async customTemplate(): Promise<{ id: number; region: { name: string } }> {
    const t = await this.api<{ custom_template?: { id: number; region: { name: string }; cpu_arch?: string | null; disks: { disk_type: string; disk_interface: string }[] }[] }>(
      'GET', '/api/v1/vm/templates', { auth: false });
    const found = (t.custom_template ?? []).find(
      (c) => (c.cpu_arch ?? 'x86_64') === 'x86_64' && c.disks.some((d) => d.disk_type === VM_SPEC.disk_type && d.disk_interface === VM_SPEC.disk_interface),
    );
    if (!found) throw new LnvpsError(404, 'LNVPS offers no x86_64 custom template with an SSD');
    return found;
  }

  async debianImage(): Promise<{ id: number; default_username?: string }> {
    const images = await this.api<{ id: number; distribution: string; version: string; default_username?: string }[]>(
      'GET', '/api/v1/image?arch=x86_64', { auth: false });
    const img = images.find((i) => i.distribution === 'debian' && i.version === '13');
    if (!img) throw new LnvpsError(404, 'LNVPS offers no Debian 13 image');
    return img;
  }

  orderVm(templateId: number, imageId: number, sshKeyId: number): Promise<Vm> {
    return this.api('POST', '/api/v1/vm/custom-template', {
      body: { pricing_id: templateId, ...VM_SPEC, image_id: imageId, ssh_key_id: sshKeyId, ref_code: LNVPS_REF_CODE },
    });
  }

  listVms(): Promise<Vm[]> {
    return this.api('GET', '/api/v1/vm');
  }

  getVm(id: number): Promise<Vm> {
    return this.api('GET', `/api/v1/vm/${id}`);
  }

  /** Starts a stopped VM; LNVPS answers before it is running. */
  async startVm(id: number): Promise<void> {
    await this.api('PATCH', `/api/v1/vm/${id}/start`);
  }

  /** Re-installs the VM's image: a new disk, so its seed and everything else on it are gone. 402 once it has expired. */
  async reinstallVm(id: number): Promise<void> {
    await this.api('PATCH', `/api/v1/vm/${id}/re-install`);
  }

  renewQuote(id: number): Promise<RenewalQuote> {
    return this.api('GET', `/api/v1/vm/${id}/renew/quote?method=lightning`);
  }

  /** Sat per day from the one-interval Lightning quote (amount, tax and fee are in millisats). */
  async satPerDay(id: number): Promise<number> {
    const q = await this.renewQuote(id);
    return (q.amount + q.tax + q.processing_fee) / 1000 / (q.time / 86400);
  }

  /** LNVPS's own Lightning invoice for one billing period of the VM: what its website pays. */
  renewVm(id: number): Promise<VmPayment> {
    return this.api('GET', `/api/v1/vm/${id}/renew?method=lightning&intervals=1`);
  }

  /** An invoice that adds `sat` worth of time to the VM, via its Lightning address. No auth, no processing fee. */
  vmInvoice(id: number, sat: number): Promise<string> {
    return lnurlPayInvoice(this.opts.fetch, `${this.base}/.well-known/lnurlp/${id}`, BigInt(sat) * 1000n, `Extend VM ${id}`);
  }
}

/** The VM, or null once LNVPS has deleted it (an unpaid order after an hour, an expired VM after its grace). */
export async function getVmOrNull(lnvps: Pick<LnvpsClient, 'getVm'>, id: number): Promise<Vm | null> {
  try {
    return await lnvps.getVm(id);
  } catch (e) {
    // 404 for an id LNVPS no longer lists, 409 for a deleted VM (API docs).
    if (e instanceof LnvpsError && [404, 409, 410].includes(e.status)) return null;
    throw e;
  }
}
