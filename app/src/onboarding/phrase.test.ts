import { describe, expect, it } from 'vitest';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { adoptPhrase, afterPick, carryOn, checkAnswers, checkPick, checkQuestions, confirmPositions, missedLine, phraseProblem, SHOW_PHRASE, wordColumns, wordCount } from './phrase';
import { initialState } from './machine';

// A BIP-39 test phrase whose words differ (the shared vector repeats "abandon").
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

describe('phrase confirmation', () => {
  it('asks for 3 different words, in order', () => {
    const seq = [5, 5, 11, 0];
    const pos = confirmPositions((n) => {
      expect(n).toBe(12);
      return seq.shift()!;
    });
    expect(pos).toEqual([0, 5, 11]);
  });
});

/** A random source that plays back a script, checking each draw's range. */
const scripted = (draws: number[]) => (n: number) => {
  const x = draws.shift();
  if (x === undefined) throw new Error('the script ran out');
  expect(x).toBeLessThan(n);
  return x;
};

/** A repeatable random source for the checks that hold whatever is drawn. */
const seeded = (seed: number) => (n: number) => {
  seed = (seed * 16807) % 2147483647;
  return seed % n;
};

// The check: each word picked from four.
describe('checkQuestions', () => {
  it('asks for three rising positions, each with four different words: the right one and three others of the phrase', () => {
    const words = PHRASE.split(' ');
    for (let seed = 1; seed <= 300; seed++) {
      const qs = checkQuestions(PHRASE, seeded(seed));
      expect(qs.map((q) => q.position)).toEqual([...new Set(qs.map((q) => q.position))].sort((a, b) => a - b));
      expect(qs).toHaveLength(3);
      for (const q of qs) {
        expect(new Set(q.choices).size).toBe(4);
        expect(q.choices).toContain(words[q.position]);
        for (const c of q.choices) expect(words).toContain(c);
      }
    }
  });

  it('draws the others and their order from the random source it is given', () => {
    // Positions 0, 5 and 11; for each, three draws from the other words left, then the shuffle's three.
    const qs = checkQuestions(PHRASE, scripted([0, 5, 11, 0, 0, 0, 0, 2, 0, 7, 0, 3, 3, 1, 1, 1, 1, 1, 2, 0, 1]));
    expect(qs).toEqual([
      { position: 0, choices: ['winner', 'year', 'thank', 'legal'] },
      { position: 5, choices: ['sausage', 'legal', 'yellow', 'wave'] },
      { position: 11, choices: ['year', 'winner', 'yellow', 'thank'] },
    ]);
  });

  it('reads the phrase in any case and spacing, as it is saved', () => {
    const loud = `  ${PHRASE.toUpperCase().replace(/ /g, '  ')}\n`;
    const draws = () => scripted([0, 5, 11, 0, 0, 0, 0, 2, 0, 7, 0, 3, 3, 1, 1, 1, 1, 1, 2, 0, 1]);
    expect(checkQuestions(loud, draws())).toEqual(checkQuestions(PHRASE, draws()));
    expect(checkPick(loud, { position: 0, choices: [] }, 'legal')).toBe(true);
  });

  it('never offers a word the phrase repeats beside itself', () => {
    // "legal" is words 1 and 9: asked for at either, the other three aren't "legal".
    for (let seed = 1; seed <= 300; seed++) {
      for (const q of checkQuestions(PHRASE, seeded(seed))) expect(q.choices.filter((c) => c === 'legal').length).toBeLessThanOrEqual(1);
    }
  });

  it('fills from the word list when the phrase has fewer than four different words', () => {
    const few = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    // Position 0 ("abandon"): "about" is the one other word; then the list's words 0 ("abandon", passed over), 1 and 2.
    const [q] = checkQuestions(few, scripted([0, 1, 2, 0, 0, 1, 2, 3, 2, 1, /* the other two questions */ 0, 4, 5, 3, 2, 1, 0, 6, 7, 3, 2, 1]));
    expect(q.position).toBe(0);
    expect([...q.choices].sort()).toEqual(['abandon', 'ability', 'able', 'about']);
    expect(wordlist.slice(0, 3)).toEqual(['abandon', 'ability', 'able']);
  });
});

describe('checkPick and checkAnswers', () => {
  const qs = [
    { position: 1, choices: ['winner', 'year', 'wave', 'yellow'] },
    { position: 6, choices: ['worth', 'legal', 'wave', 'useful'] },
    { position: 11, choices: ['thank', 'yellow', 'wave', 'year'] },
  ];
  it('takes the word at the position, and no other', () => {
    expect(checkPick(PHRASE, qs[0], 'winner')).toBe(true);
    expect(checkPick(PHRASE, qs[0], 'year')).toBe(false);
    // Another position's word isn't this one's.
    expect(checkPick(PHRASE, qs[0], 'worth')).toBe(false);
    expect(checkPick(PHRASE, qs[0], null)).toBe(false);
  });
  it('passes only three right words, whatever the others were', () => {
    expect(checkAnswers(PHRASE, qs, ['winner', 'worth', 'yellow'])).toBe(true);
    expect(checkAnswers(PHRASE, qs, ['year', 'worth', 'yellow'])).toBe(false);
    expect(checkAnswers(PHRASE, qs, ['winner', 'legal', 'yellow'])).toBe(false);
    expect(checkAnswers(PHRASE, qs, ['winner', 'worth', 'thank'])).toBe(false);
    expect(checkAnswers(PHRASE, qs, ['winner', 'worth', null])).toBe(false);
    expect(checkAnswers(PHRASE, qs, ['winner', 'worth'])).toBe(false);
  });
  // A tap on a word is the answer: there is no Next to press after it.
  it('moves to the next word on a right tap, keeping the pick', () => {
    expect(afterPick(PHRASE, qs, [null, null, null], 0, 'winner')).toEqual({ step: 'next', at: 1, picks: ['winner', null, null] });
    expect(afterPick(PHRASE, qs, ['winner', null, null], 1, 'worth')).toEqual({ step: 'next', at: 2, picks: ['winner', 'worth', null] });
  });
  it('shows the words again on a wrong tap, naming the word asked for', () => {
    expect(afterPick(PHRASE, qs, [null, null, null], 0, 'year')).toEqual({ step: 'missed', position: 1 });
    expect(afterPick(PHRASE, qs, ['winner', 'worth', null], 2, 'thank')).toEqual({ step: 'missed', position: 11 });
  });
  it('saves on the third right tap, and only when all three are right', () => {
    expect(afterPick(PHRASE, qs, ['winner', 'worth', null], 2, 'yellow')).toEqual({ step: 'save', picks: ['winner', 'worth', 'yellow'] });
    expect(afterPick(PHRASE, qs, ['year', 'worth', null], 2, 'yellow')).toEqual({ step: 'missed', position: 11 });
  });
  it('wants three questions at three positions', () => {
    expect(checkAnswers(PHRASE, qs.slice(0, 2), ['winner', 'worth'])).toBe(false);
    expect(checkAnswers(PHRASE, [qs[0], qs[0], qs[0]], ['winner', 'winner', 'winner'])).toBe(false);
    expect(checkAnswers(PHRASE, [], [])).toBe(false);
  });
});

describe('missedLine', () => {
  it('names the word that was picked wrong, counted from 1 as the paper has it', () => {
    expect(missedLine(6)).toBe('Word 7 on your paper didn’t match. Check your paper against these words.');
    expect(missedLine(0)).toContain('Word 1 ');
  });
});

// Onboarding's phrase screen and Settings › Recovery phrase: the words numbered, in order.
describe('wordColumns', () => {
  it('numbers the words down two columns: 1 to 6, then 7 to 12', () => {
    const [left, right] = wordColumns(PHRASE);
    expect(left).toEqual([
      { n: 1, word: 'legal' }, { n: 2, word: 'winner' }, { n: 3, word: 'thank' }, { n: 4, word: 'year' }, { n: 5, word: 'wave' }, { n: 6, word: 'sausage' },
    ]);
    expect(right.map((w) => w.n)).toEqual([7, 8, 9, 10, 11, 12]);
    expect(right[5]).toEqual({ n: 12, word: 'yellow' });
  });
  it('reads a saved phrase in any case and spacing, and nothing as no words', () => {
    expect(wordColumns('  Legal\tWINNER   thank\n')).toEqual([[{ n: 1, word: 'legal' }, { n: 2, word: 'winner' }], [{ n: 3, word: 'thank' }]]);
    expect(wordColumns('   ')).toEqual([[], []]);
  });
});

describe('wordCount', () => {
  it('counts the words typed so far, whatever lies between them', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('   \n')).toBe(0);
    expect(wordCount('legal winner thank year wave sausage worth useful legal')).toBe(9);
    expect(wordCount(PHRASE)).toBe(12);
    expect(wordCount(`  ${PHRASE.replace(/ /g, '  \n')} legal  winner `)).toBe(14);
  });
});

// "I already have a recovery phrase": typed or pasted, so it says what is wrong.
describe('phraseProblem', () => {
  it('accepts the 12 words in any case, spacing or line breaks', () => {
    expect(phraseProblem(PHRASE)).toBeNull();
    expect(phraseProblem(`  ${PHRASE.toUpperCase().replace(/ /g, '\n')}\n`)).toBeNull();
  });
  it('counts the words', () => {
    expect(phraseProblem('')).toBe('Enter all 12 words.');
    expect(phraseProblem(PHRASE.split(' ').slice(0, 11).join(' '))).toBe('Enter all 12 words (you have 11).');
    expect(phraseProblem(`${PHRASE} legal`)).toBe('A recovery phrase has 12 words (you have 13).');
  });
  it('names a word that is not on the list', () => {
    expect(phraseProblem(PHRASE.replace('sausage', 'sausag'))).toBe('Word 6, “sausag”, isn’t a recovery phrase word. Check its spelling.');
  });
  it('catches listed words that do not make a phrase', () => {
    expect(phraseProblem(PHRASE.replace('yellow', 'winner'))).toBe('These words don’t make a valid phrase. Check each word and their order.');
  });
});

describe('adoptPhrase', () => {
  const deps = () => {
    const saved: unknown[] = [];
    let stored: string | null = null;
    let keys = 0;
    return {
      saved,
      stored: () => stored,
      keys: () => keys,
      phrase: { set: async (p: string) => void (stored = p) },
      deviceKey: { create: async () => void keys++ },
      store: { saveOnboarding: async (st: unknown) => void saved.push(st) },
    };
  };
  it('stores the phrase, makes the device key and starts onboarding afresh', async () => {
    const d = deps();
    await adoptPhrase(` ${PHRASE.toUpperCase()} `, d);
    expect(d.stored()).toBe(PHRASE);
    expect(d.keys()).toBe(1);
    expect(d.saved).toEqual([initialState()]);
  });
  // A phrase typed back in: with no paid VM left, onboarding offers a rebuild.
  it('marks onboarding as a restore when the phrase is typed back in', async () => {
    const d = deps();
    await adoptPhrase(PHRASE, d, { restoring: true });
    expect(d.saved).toEqual([{ ...initialState(), restoring: true }]);
  });
  // A backed-up 'done' state must never sit beside the new phrase (the app would open its Home).
  it('starts onboarding afresh before anything that can fail after the phrase is stored', async () => {
    const d = deps();
    d.deviceKey.create = async () => {
      throw new Error('keystore');
    };
    await expect(adoptPhrase(PHRASE, d)).rejects.toThrow('keystore');
    expect(d.stored()).toBe(PHRASE);
    expect(d.saved).toEqual([initialState()]);
  });
  it('stores nothing for a phrase with a problem', async () => {
    const d = deps();
    await expect(adoptPhrase(PHRASE.replace('yellow', 'winner'), d)).rejects.toThrow('don’t make a valid phrase');
    expect([d.stored(), d.keys(), d.saved.length]).toEqual([null, 0, 0]);
  });
});

// Settings › Recovery phrase.
describe('SHOW_PHRASE', () => {
  it('warns before the lock, and says on the words that they go when the screen is left', () => {
    expect(SHOW_PHRASE).toEqual({
      band: 'Recovery phrase',
      intro: 'Your 12 words are the only way to get your server, cards and money back.',
      warning: 'Anyone who sees them can take the money. Show them only where no one else can see the screen.',
      button: 'Unlock to show the words',
      write: 'Write these 12 words on paper, in order, and keep the paper safe.',
      foot: 'Screenshots are blocked here, and the words go when you leave this screen.',
    });
  });
});

// A wallet found on an iPhone is carried on, and
// an iPhone the server no longer knows is paired again, by the steps of a restore with the words already there.
describe('carryOn', () => {
  /** fail: the call that fails. */
  const deps = (fail?: 'remove' | 'create' | 'save') => {
    const did: string[] = [];
    const saved: unknown[] = [];
    const step = (name: string, failing: boolean) => async () => {
      if (failing) throw new Error(`${name} failed`);
      did.push(name);
    };
    return {
      did,
      saved,
      deviceKey: { remove: step('remove the key', fail === 'remove'), create: step('make a key', fail === 'create') },
      store: {
        setRevoked: async (revoked: boolean) => void did.push(`revoked: ${revoked}`),
        saveOnboarding: async (st: unknown) => {
          if (fail === 'save') throw new Error('save failed');
          saved.push(st);
          did.push('save the state');
        },
      },
      forget: () => void did.push('forget'),
    };
  };

  // Let go before the state is saved: a key check or a Retire VM still on its way would else save the old server's
  // state over the restore's first one (the watch saves nothing it read before it was told to forget).
  it('gives the phone a new key, lets go of what the running app held, then starts a restore', async () => {
    const d = deps();
    await carryOn(d);
    expect(d.did).toEqual(['remove the key', 'make a key', 'forget', 'revoked: false', 'save the state']);
    expect(d.saved).toEqual([{ ...initialState(), restoring: true }]);
  });

  // The server refuses for good to pair a key it has revoked: an old key is never kept.
  it('saves nothing when the old key cannot be removed, and makes no key', async () => {
    const d = deps('remove');
    await expect(carryOn(d)).rejects.toThrow('remove the key failed');
    expect(d.did).toEqual([]);
    expect(d.saved).toEqual([]);
  });

  it('saves nothing when no new key can be made', async () => {
    const d = deps('create');
    await expect(carryOn(d)).rejects.toThrow('make a key failed');
    expect(d.did).toEqual(['remove the key']);
    expect(d.saved).toEqual([]);
  });

  it('keeps what the running app held while the phone has no new key', async () => {
    for (const fail of ['remove', 'create'] as const) {
      const d = deps(fail);
      await expect(carryOn(d)).rejects.toThrow();
      expect(d.did).not.toContain('forget');
    }
  });

  it('says so when the state could not be saved, the new key made and the old state left', async () => {
    const d = deps('save');
    await expect(carryOn(d)).rejects.toThrow('save failed');
    expect(d.did).toEqual(['remove the key', 'make a key', 'forget', 'revoked: false']);
    expect(d.saved).toEqual([]);
  });
});
