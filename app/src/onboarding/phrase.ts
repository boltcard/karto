// Showing the new phrase and asking for 3 of its words back, each picked from four,
// or taking one the person already has.
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { isValidPhrase, normalisePhrase } from '../keys/derive';
import { initialState, type OnboardingState } from './machine';

/** Uniform integer in [0, n) from the platform's secure random source. */
export function secureRandomInt(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  do globalThis.crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % n;
}

/** Three different word positions (0-based) to ask for, in order. */
export function confirmPositions(randomInt: (n: number) => number = secureRandomInt): number[] {
  const picked = new Set<number>();
  while (picked.size < 3) picked.add(randomInt(12));
  return [...picked].sort((a, b) => a - b);
}

/** One of the check's three questions: a word's position (0-based) and the four words offered for it. */
export type CheckQuestion = { position: number; choices: string[] };

/**
 * The check: three positions, and
 * for each the right word among three others, all four different, in a random order. The others come from the
 * phrase, so the check tests the order on the paper (a copy with two words swapped fails it); a phrase with fewer
 * than four different words fills the rest from the BIP39 list.
 */
export function checkQuestions(phrase: string, randomInt: (n: number) => number = secureRandomInt): CheckQuestion[] {
  const words = normalisePhrase(phrase).split(' ');
  return confirmPositions(randomInt).map((position) => {
    const right = words[position];
    const others = [...new Set(words)].filter((w) => w !== right);
    const choices = [right];
    while (choices.length < 4) {
      const word = others.length ? others.splice(randomInt(others.length), 1)[0] : wordlist[randomInt(wordlist.length)];
      if (!choices.includes(word)) choices.push(word);
    }
    for (let i = choices.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [choices[i], choices[j]] = [choices[j], choices[i]];
    }
    return { position, choices };
  });
}

/** Whether the word picked for a question is the phrase's word at its position. */
export function checkPick(phrase: string, q: CheckQuestion, pick: string | null): boolean {
  return pick !== null && normalisePhrase(phrase).split(' ')[q.position] === pick;
}

/** The one gate before the phrase is saved: three questions at three positions, each with its right word picked. */
export function checkAnswers(phrase: string, questions: CheckQuestion[], picks: (string | null)[]): boolean {
  return (
    questions.length === 3 &&
    picks.length === 3 &&
    new Set(questions.map((q) => q.position)).size === 3 &&
    questions.every((q, i) => checkPick(phrase, q, picks[i]))
  );
}

/** Where a tap on a word leads: the next question, the save, or the words again with the missed position (0-based). */
export type PickStep =
  | { step: 'next'; at: number; picks: (string | null)[] }
  | { step: 'save'; picks: (string | null)[] }
  | { step: 'missed'; position: number };

/**
 * A tap on a word is the answer to question `at` (no Next to press after it). A right word goes on to the next
 * question; the third goes to the save, through the one gate (`checkAnswers`); a wrong word shows the words again.
 */
export function afterPick(phrase: string, questions: CheckQuestion[], picks: (string | null)[], at: number, word: string): PickStep {
  const q = questions[at];
  if (!checkPick(phrase, q, word)) return { step: 'missed', position: q.position };
  const picked = picks.map((p, i) => (i === at ? word : p));
  if (at < questions.length - 1) return { step: 'next', at: at + 1, picks: picked };
  return checkAnswers(phrase, questions, picked) ? { step: 'save', picks: picked } : { step: 'missed', position: q.position };
}

/** What the words screen says after a wrong pick (position: 0-based): the person compares the paper with the words. */
export const missedLine = (position: number): string => `Word ${position + 1} on your paper didn’t match. Check your paper against these words.`;

/**
 * Settings › Recovery phrase's words (app/show-phrase.tsx): the page before the screen lock,
 * with its warning in an amber panel and a button that says what pressing it asks for, and the words' page.
 */
export const SHOW_PHRASE = {
  band: 'Recovery phrase',
  intro: 'Your 12 words are the only way to get your server, cards and money back.',
  warning: 'Anyone who sees them can take the money. Show them only where no one else can see the screen.',
  button: 'Unlock to show the words',
  write: 'Write these 12 words on paper, in order, and keep the paper safe.',
  foot: 'Screenshots are blocked here, and the words go when you leave this screen.',
} as const;

/** The words numbered down two columns, as they are shown to be written down: 1 to 6, then 7 to 12. */
export function wordColumns(phrase: string): { n: number; word: string }[][] {
  const words = normalisePhrase(phrase).split(' ').filter(Boolean).map((word, i) => ({ n: i + 1, word }));
  const half = Math.ceil(words.length / 2);
  return [words.slice(0, half), words.slice(half)];
}

/** How many words a typed or pasted phrase holds so far. */
export const wordCount = (text: string): number => normalisePhrase(text).split(' ').filter(Boolean).length;

/** What is wrong with a typed or pasted phrase, in words the person can act on; null if nothing. */
export function phraseProblem(text: string): string | null {
  const words = normalisePhrase(text).split(' ').filter(Boolean);
  if (words.length < 12) return words.length ? `Enter all 12 words (you have ${words.length}).` : 'Enter all 12 words.';
  if (words.length > 12) return `A recovery phrase has 12 words (you have ${words.length}).`;
  const unknown = words.findIndex((w) => !wordlist.includes(w));
  if (unknown >= 0) return `Word ${unknown + 1}, “${words[unknown]}”, isn’t a recovery phrase word. Check its spelling.`;
  if (!isValidPhrase(words.join(' '))) return 'These words don’t make a valid phrase. Check each word and their order.';
  return null;
}

/**
 * Makes the phrase this app's (new or restored) and starts onboarding with it.
 * restoring: typed back in, so onboarding offers a rebuild when no paid server is left.
 */
export async function adoptPhrase(
  phrase: string,
  d: {
    phrase: { set(phrase: string): Promise<void> };
    deviceKey: { create(): Promise<unknown> };
    store: { saveOnboarding(s: OnboardingState): Promise<void> };
  },
  o: { restoring?: boolean } = {},
): Promise<void> {
  const problem = phraseProblem(phrase);
  if (problem) throw new Error(problem);
  // set() refuses to replace a phrase, so it goes first; then the fresh state at once, so a
  // backed-up old one is never left beside the new phrase if making the key fails.
  await d.phrase.set(normalisePhrase(phrase));
  await d.store.saveOnboarding(o.restoring ? { ...initialState(), restoring: true } : initialState());
  await d.deviceKey.create();
}

/**
 * Carries on with the wallet whose phrase is already on the phone:
 * a wallet found after the app was deleted and installed again, and an iPhone that has lost its
 * key or whose pairing the server revoked. It is a restore with the words already there, so the phrase is not
 * touched. The phone gets a new key: an old one may have been revoked while the app was away, and the server
 * refuses for good to pair a key it has revoked. Then what the running app held for the wallet's server is let go
 * (forget), and only then the first state of a restore is saved: the server watch saves nothing it read before it
 * was told to forget, so a check still on its way cannot save the old server's state over the new one, and
 * onboarding starts from that state and nothing older. A failure saves nothing after it.
 */
export async function carryOn(d: {
  deviceKey: { remove(): Promise<unknown>; create(): Promise<unknown> };
  store: { setRevoked(revoked: boolean): Promise<void>; saveOnboarding(s: OnboardingState): Promise<void> };
  forget(): void;
}): Promise<void> {
  await d.deviceKey.remove();
  await d.deviceKey.create();
  d.forget();
  await d.store.setRevoked(false);
  await d.store.saveOnboarding({ ...initialState(), restoring: true });
}
