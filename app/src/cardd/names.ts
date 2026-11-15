// A name as cardd keeps it and a till shows it: a PoS phone's, and the wallet's.
// cardd's own check is store.CleanName. A leaf: Karto PoS imports it, so it
// imports nothing.

/** cardd's limit on a name, in characters (code points). */
export const NAME_MAX = 24;

/** No character of a name: the controls, and the marks that hide in a line or turn it round. */
// eslint-disable-next-line no-control-regex
export const NOT_IN_A_NAME = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

/** Whether a name is one cardd gives or keeps: trimmed, 1 to 24 characters, all of them to be seen. */
export const isName = (name: unknown): name is string =>
  typeof name === 'string' && name !== '' && name === name.trim() && [...name].length <= NAME_MAX && !NOT_IN_A_NAME.test(name);
