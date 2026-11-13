import { describe, expect, it } from 'vitest'

import { activationLink, code128SVG, code128Values, codesInRange, hashSecret, lotForCode, newSecret, normalizeKitCode, normalizeLotNumber, normalizeSecret, orderSummary, parseTracking, progressOf, secretMatches, statusAfter } from '../src/index.js'

// Made-up codes and secrets only.
const PEPPER = 'made-up-pepper'

describe('codes', () => {
  it('reads codes typed with spaces, scanned, or from an activation link', () => {
    expect(normalizeKitCode(' 2758 6400 0115 ')).toBe('275864000115')
    expect(normalizeKitCode('https://x.test/my-tests/activate?kit=275864000115#s=ABCDE-FGHJK')).toBe('275864000115')
    expect(normalizeKitCode('abc')).toBeNull()
    expect(normalizeKitCode('1234567')).toBeNull()
    expect(normalizeLotNumber('27-58 64')).toBe('275864')
    expect(normalizeLotNumber('12')).toBeNull()
    expect(codesInRange('275864', 115, 117, 6)).toEqual(['275864000115', '275864000116', '275864000117'])
    expect(() => codesInRange('275864', 5, 1_000_000, 6)).toThrow()
    expect(parseTracking('9400 1000 0000 0000 0000 01, 1z999aa10123456784\n\n')).toEqual(['9400100000000000000001', '1Z999AA10123456784'])
    expect(lotForCode('275864000115', [{ lotNumber: '2758' }, { lotNumber: '275864' }, { lotNumber: '999' }])?.lotNumber).toBe('275864')
  })
})

describe('secrets', () => {
  it('makes readable secrets that always hold a letter, and still reads an all-digit slip printed before the move', () => {
    for (let i = 0; i < 200; i++) expect(newSecret()).toMatch(/^(?=.*[A-Z])[2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5}$/)
    expect(normalizeSecret('23456-78923')).toBe('2345678923')
    // An old all-digit secret still opens its own kit; the kit's code as its secret never does.
    const old = hashSecret(PEPPER, '275864000115', '2345678923')
    expect(secretMatches(PEPPER, '275864000115', '23456-78923', old)).toBe(true)
    expect(secretMatches(PEPPER, '2345678923', '2345678923', hashSecret(PEPPER, '2345678923', '2345678923'))).toBe(false)
    expect(normalizeSecret('abcde-fghjk')).toBe('ABCDEFGHJK')
    expect(normalizeSecret('ABCDE-FGHJO')).toBeNull() // O isn't in the alphabet
  })

  it('binds a secret to its kit and the site, and keeps it out of the link sent to servers', () => {
    const secret = newSecret()
    const hash = hashSecret(PEPPER, '275864000115', normalizeSecret(secret)!)
    expect(secretMatches(PEPPER, '275864000115', secret.toLowerCase(), hash)).toBe(true)
    expect(secretMatches(PEPPER, '275864000116', secret, hash)).toBe(false)
    expect(secretMatches('another-site', '275864000115', secret, hash)).toBe(false)
    expect(secretMatches(PEPPER, '275864000115', 'AAAAA-AAAAA', hash)).toBe(false)
    expect(secretMatches(PEPPER, '275864000115', secret, null)).toBe(false)
    expect(secretMatches(PEPPER, '275864000115', secret, 'short')).toBe(false)
    const link = activationLink('https://example.test/', '275864000115', secret)
    expect(link).toBe(`https://example.test/my-tests/activate?kit=275864000115#s=${secret}`)
    expect(link.split('#')[0]).not.toContain(secret)
  })

  it('matches hashes the site made before the move, with the same pepper', () => {
    // The site hashed `${PAYLOAD_SECRET}|kit|${code}|${secret}` with SHA-256; the plugin must too.
    expect(hashSecret('p', '275864000115', 'ABCDEFGHJK')).toBe('8605dd5a032360e6d71b38530de1e408fef1b290345c2dd517390234cef12b8d')
  })
})

describe('barcodes and statuses', () => {
  it('draws Code 128 with the right check digit', () => {
    // Check digit: (105 + 27·1 + 58·2 + 64·3 + 0·4 + 1·5 + 15·6) mod 103 = 20.
    expect(code128Values('275864000115')).toEqual([105, 27, 58, 64, 0, 1, 15, 20, 106])
    expect(code128SVG('275864000115')).toContain('aria-label="275864000115"')
    expect(() => code128Values('')).toThrow()
  })

  it('maps events to statuses and statuses to the customer’s steps', () => {
    expect(statusAfter('received')).toBe('in-stock')
    expect(statusAfter('unpacked')).toBe('in-stock')
    expect(statusAfter('activated')).toBe('activated')
    expect(statusAfter('note')).toBeNull()
    expect(statusAfter('slip-made')).toBeNull()
    expect(progressOf('sampled')).toEqual({ step: 3, problem: null })
    expect(progressOf('lost')).toEqual({ step: -1, problem: 'lost' })
    expect(orderSummary('shipped', ['shipped', 'activated', 'activated', 'replaced', 'lost'])).toEqual({ stage: 'underway', steps: [{ step: 'shipped', n: 1 }, { step: 'activated', n: 2 }], attention: 1, replaced: 1 })
  })
})
