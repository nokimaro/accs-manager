import { describe, expect, it } from 'vitest'
import { takeLeastLoaded } from '../src/services/accounts.ts'

describe('takeLeastLoaded', () => {
  it('takes the proxy with the fewest accounts and counts the pick', () => {
    const loads = new Map([
      ['a', 2],
      ['b', 0],
      ['c', 1],
    ])
    expect(takeLeastLoaded(loads)).toBe('b')
    expect(loads.get('b')).toBe(1)
  })

  it('picks at random among equally loaded proxies', () => {
    const loads = () =>
      new Map([
        ['a', 1],
        ['b', 0],
        ['c', 0],
        ['d', 0],
      ])
    expect(takeLeastLoaded(loads(), () => 0)).toBe('b')
    expect(takeLeastLoaded(loads(), () => 0.5)).toBe('c')
    expect(takeLeastLoaded(loads(), () => 0.99)).toBe('d')
  })

  it('spreads several picks evenly and gives null with no proxy at all', () => {
    const loads = new Map([
      ['a', 0],
      ['b', 0],
    ])
    const picks = Array.from({ length: 4 }, () => takeLeastLoaded(loads))
    expect(picks.filter((p) => p === 'a')).toHaveLength(2)
    expect(takeLeastLoaded(new Map())).toBeNull()
  })
})
