import { expect, vi } from 'vitest'

/**
 * Watches web storage and cookies for a test file: nothing the components do may write to either. `check()` after each
 * test fails if anything was written.
 */
export function watchStorage() {
  const writes: string[] = []
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string) {
    writes.push(`storage:${key}`)
  })
  const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => '',
    set: (v: string) => void writes.push(`cookie:${v.split('=')[0]}`),
  })
  return {
    reset: () => void (writes.length = 0),
    check: () => {
      expect(writes, 'nothing is written to web storage or cookies').toEqual([])
      for (const store of [window.localStorage, window.sessionStorage]) if (store) expect(store.length).toBe(0)
      expect(setItem).not.toHaveBeenCalled()
      void desc
    },
  }
}
