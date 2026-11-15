import { describe, expect, it } from 'vitest';
import { chargeAnswered, chargePressed, saleDrawn } from './chargeTiming';

describe('the Charge timing line', () => {
  it('times Charge to the answer and to the sale screen, once a sale', () => {
    chargePressed('fiat', 1_000);
    chargeAnswered('s1', 1_212.4);
    expect(saleDrawn('s1', 1_251.6)).toBe('CARDAPP-CHARGE {"unit":"fiat","answerMs":212,"drawnMs":252}');
    expect(saleDrawn('s1', 1_300)).toBeNull();
  });

  it('says nothing for a sale Charge did not open, or before cardd answered', () => {
    chargePressed('sat', 0);
    expect(saleDrawn('s2', 10)).toBeNull();
    chargeAnswered('s2', 100);
    expect(saleDrawn('other', 120)).toBeNull();
    expect(saleDrawn('s2', 130)).toBe('CARDAPP-CHARGE {"unit":"sat","answerMs":100,"drawnMs":130}');
  });
});
