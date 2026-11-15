// The card connection as the card flows see it, and what can go wrong on it.

/** Sends one command APDU to the card in the field and returns its answer (data, then SW1 SW2). */
export type Transceive = (apdu: Uint8Array) => Promise<Uint8Array>;

/** The card left the field, or the connection closed, before it answered. */
export class TagLostError extends Error {
  constructor(message = 'The card was moved away from the phone.') {
    super(message);
    this.name = 'TagLostError';
  }
}

export const SW = {
  OK: 0x9100,
  MORE: 0x91af,
  ISO_OK: 0x9000,
  AUTH_ERROR: 0x91ae,
  PERMISSION_DENIED: 0x919d,
  NOT_FOUND: 0x6a82,
} as const;

const NAMES: Record<number, string> = {
  0x91ae: 'authentication error',
  0x919d: 'permission denied',
  0x911e: 'integrity error',
  0x917e: 'length error',
  0x9140: 'no such key',
  0x919e: 'parameter error',
  0x91f0: 'file not found',
  0x91ca: 'command aborted',
  0x91ee: 'memory error',
  0x911c: 'illegal command',
  0x91be: 'boundary error',
  0x6982: 'security status not satisfied',
  0x6a82: 'file or application not found',
  0x6700: 'wrong length',
  0x6a86: 'wrong parameters',
  0x6d00: 'instruction not supported',
};

/** The card answered a command with an error status word. */
export class CardError extends Error {
  constructor(readonly command: string, readonly sw: number) {
    super(`${command}: the card answered ${sw.toString(16).toUpperCase().padStart(4, '0')} (${NAMES[sw] ?? 'unknown status'})`);
    this.name = 'CardError';
  }
}

export function splitResponse(command: string, r: Uint8Array): { data: Uint8Array; sw: number } {
  if (r.length < 2) throw new CardError(command, 0);
  return { data: r.subarray(0, r.length - 2), sw: (r[r.length - 2] << 8) | r[r.length - 1] };
}
