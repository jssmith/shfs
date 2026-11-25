import { describe, expect, test } from 'vitest';
import { abaRoutingValid, ibanValid, luhnValid, mrzCheckDigit, nhsNumberValid, ssnPlausible } from './checksums.js';

describe('checksums', () => {
  test('Luhn', () => {
    expect(luhnValid('4539 1488 0343 6467')).toBe(true);
    expect(luhnValid('4539-1488-0343-6468')).toBe(false);
    expect(luhnValid('79927398713')).toBe(false); // too short for a card
    expect(luhnValid('abcd')).toBe(false);
  });

  test('IBAN mod-97, with country lengths', () => {
    expect(ibanValid('GB82 WEST 1234 5698 7654 32')).toBe(true); // the ISO 13616 example
    expect(ibanValid('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(ibanValid('GB82 WEST 1234 5698 7654 33')).toBe(false);
    expect(ibanValid('DE89 3704 0044 0532 0130')).toBe(false); // wrong length
    expect(ibanValid('XX82 WEST 1234 5698 7654 32')).toBe(false); // unknown country
  });

  test('ABA routing number', () => {
    expect(abaRoutingValid('011000015')).toBe(true);
    expect(abaRoutingValid('011000016')).toBe(false);
    expect(abaRoutingValid('000000000')).toBe(false);
  });

  test('SSN ranges', () => {
    expect(ssnPlausible('123-45-6789')).toBe(true);
    expect(ssnPlausible('000-45-6789')).toBe(false);
    expect(ssnPlausible('666-45-6789')).toBe(false);
    expect(ssnPlausible('912-45-6789')).toBe(false);
    expect(ssnPlausible('123-00-6789')).toBe(false);
  });

  test('ICAO 9303 check digits (specimen values from the standard)', () => {
    expect(mrzCheckDigit('L898902C3')).toBe('6');
    expect(mrzCheckDigit('740812')).toBe('2');
    expect(mrzCheckDigit('120415')).toBe('9');
  });

  test('NHS number mod-11', () => {
    expect(nhsNumberValid('943 476 5919')).toBe(true);
    expect(nhsNumberValid('943 476 5918')).toBe(false);
  });
});
