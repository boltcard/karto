import { describe, expect, it } from 'vitest';
import { COUNTRIES } from './countries';
import { continueLabel, EU_VAT, expectedVat, vatLabel } from './vat';

describe('expected VAT on the country picker', () => {
  it('knows the standard rate of every EU member, and nothing else', () => {
    expect(Object.keys(EU_VAT)).toHaveLength(27);
    expect(Object.keys(EU_VAT).every((a3) => COUNTRIES.some((c) => c.alpha3 === a3))).toBe(true);
    expect(expectedVat('IRL')).toBe(23);
    expect(expectedVat('DEU')).toBe(19);
    expect(expectedVat('FIN')).toBe(25.5);
  });

  it('expects no VAT outside the EU', () => {
    expect(expectedVat('GBR')).toBe(0);
    expect(expectedVat('USA')).toBe(0);
    expect(expectedVat('CHE')).toBe(0);
  });

  it('puts the VAT on the Continue button too', () => {
    expect(continueLabel('GBR')).toBe('Continue with United Kingdom (no VAT)');
    expect(continueLabel('IRL')).toBe('Continue with Ireland (VAT 23%)');
    expect(continueLabel(undefined)).toBe('Choose a country');
  });

  it('labels it for the list', () => {
    expect(vatLabel(0)).toBe('no VAT');
    expect(vatLabel(23)).toBe('VAT 23%');
    expect(vatLabel(25.5)).toBe('VAT 25.5%');
  });
});
