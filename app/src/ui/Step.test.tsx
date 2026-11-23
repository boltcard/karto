// A step list's row, rendered: an install step's name and its time stay on one line, shrinking rather than
// wrapping when the font is large or the phone narrow; a checklist's row, whose line after the name is words, wraps.
// react-native-web drops the props it has no use for (adjustsFontSizeToFit), so the Text is watched for them.
import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Step } from './ui';

type TextProps = ComponentProps<typeof import('react-native').Text>;
const { seen } = vi.hoisted(() => ({ seen: [] as TextProps[] }));
vi.mock('react-native', async (original) => {
  const rn = await original<typeof import('react-native')>();
  const { createElement } = await import('react');
  const Text = (props: TextProps) => {
    seen.push(props);
    return createElement(rn.Text, props);
  };
  return { ...rn, Text };
});

/** The Text drawing the row's name, and its time inside it. */
const labelText = (label: string) => seen.filter((p) => Array.isArray(p.children) && p.children[0] === label).at(-1);

describe('Step', () => {
  beforeEach(() => void seen.splice(0));

  it("keeps an install step's name and its time on one line, shrinking it to fit", () => {
    render(<Step label="Confirm with LNVPS" status="done" time="0.2 s" spoken="Confirm with LNVPS, done, 0.2 seconds" oneLine />);
    expect(screen.getByText('Confirm with LNVPS', { exact: false }).textContent).toBe('Confirm with LNVPS · 0.2 s');
    expect(labelText('Confirm with LNVPS')).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.7 });
    // A screen reader still reads the row as one, with its own words.
    expect(screen.getByLabelText('Confirm with LNVPS, done, 0.2 seconds')).toBeTruthy();
  });

  it('keeps the name on one line before its time comes', () => {
    render(<Step label="Upload the server files" status="todo" spoken="Upload the server files, to do" oneLine />);
    expect(labelText('Upload the server files')).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true });
  });

  it("lets a checklist's row wrap: the words after its name are a sentence, not a time", () => {
    render(<Step label="Let ntfy run in the background" status="done" time="Not set: alerts may come late" />);
    const p = labelText('Let ntfy run in the background');
    expect(p).toBeDefined();
    expect(p!.numberOfLines).toBeUndefined();
    expect(p!.adjustsFontSizeToFit).toBeUndefined();
  });
});
