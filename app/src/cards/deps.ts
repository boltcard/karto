// What the card flows (identify, add, wipe, re-point, check) need from the rest of the app.
import type { CarddClient } from '../cardd/client';
import { withTimeout, type FetchFn } from '../lightning/lightning';
import type { AppStore } from '../store/store';

export { isNetworkFailure } from '../lightning/lightning';

/**
 * How long a call to the server may take while a card is held:
 * an iPhone lets go of a card after about 20 seconds, and on either phone the person is holding a
 * card to a screen that says nothing new. A call that gives up fails as a network failure.
 */
export const HELD_CALL_MS = 5000;
/** The fetch of the client the card jobs ask with a card held. */
export const heldFetch = (fetch: FetchFn): FetchFn => withTimeout(fetch, HELD_CALL_MS);

export type CardDeps = {
  /** The phrase's issuer key (DerivedKeys.issuerKey, as bytes). */
  issuer: Uint8Array;
  cardd: Pick<CarddClient, 'reserveCard' | 'adoptCard' | 'setCardHost' | 'cards' | 'confirmCard' | 'checkCard' | 'wipeCard' | 'wipedCard' | 'wallet' | 'reconcileBooks' | 'restoreBooks' | 'history' | 'move' | 'send' | 'lookup' | 'sendState' | 'recentSends' | 'removeRecent' | 'freezeCard' | 'unfreezeCard' | 'setLimits' | 'setCurrency' | 'setWalletName' | 'hosting' | 'syncHosting' | 'renewNow' | 'backups' | 'backupFile' | 'cardPhoto' | 'setCardPhoto' | 'removeCardPhoto' | 'shopCode' | 'dropShopCode' | 'shopPhones' | 'renameShopPhone' | 'removeShopPhone' | 'salesDays' | 'transaction' | 'setComment' | 'refund'>;
  /** The same calls, each giving up after HELD_CALL_MS: every call a card job makes (a card is held). cardd is for the rest. */
  held: CardDeps['cardd'];
  cache: Pick<AppStore, 'cards' | 'saveCard' | 'pendingRequests' | 'savePending' | 'dropPending' | 'photos' | 'savePhoto' | 'dropPhoto' | 'removedPhoneCards' | 'noteRemovedPhoneCard' | 'dismissRemovedPhoneCards'>;
  /** This server's hostname: cards carry lnurlw://<host>/ln. */
  host: string;
};

/** A flow stopped with something to tell the person: not a lifted card, not a card's refusal. */
export class CardFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardFlowError';
  }
}
