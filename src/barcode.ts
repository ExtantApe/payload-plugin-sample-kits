/**
 * Code 128 barcodes as SVG, made here, so they work offline at any size. Preprinted kit tubes
 * commonly use Code 128 for numeric codes; all-digit codes of even length use code set C (two
 * digits per symbol, shortest bars), anything else code set B.
 */

// Bar/space widths for symbol values 0–106 (106 = stop, which has a final 2-wide bar).
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
]
const START_B = 104
const START_C = 105
const STOP = 106

/** Symbol values for `text`, with start, checksum and stop. */
export function code128Values(text: string): number[] {
  if (!text || text.length > 80) throw new Error('Barcode text must be 1 to 80 characters.')
  const useC = /^\d+$/.test(text) && text.length % 2 === 0
  const values = [useC ? START_C : START_B]
  if (useC) for (let i = 0; i < text.length; i += 2) values.push(Number(text.slice(i, i + 2)))
  else
    for (const ch of text) {
      const code = ch.charCodeAt(0)
      if (code < 32 || code > 126) throw new Error('Barcodes can hold plain letters, digits and punctuation only.')
      values.push(code - 32)
    }
  const checksum = values.reduce((sum, v, i) => sum + v * (i === 0 ? 1 : i), 0) % 103
  return [...values, checksum, STOP]
}

/** Module widths, alternating bar and space, starting with a bar. */
export function code128Modules(text: string): number[] {
  return code128Values(text).flatMap((v) => [...PATTERNS[v]!].map(Number))
}

/**
 * The barcode as an SVG string that stretches to its box. A quiet zone of 10 modules on each side
 * keeps scanners happy; `crispEdges` keeps bars sharp on thermal printers.
 */
export function code128SVG(text: string, { title }: { title?: string } = {}): string {
  const modules = code128Modules(text)
  const quiet = 10
  const width = modules.reduce((s, m) => s + m, 0) + quiet * 2
  let x = quiet
  let bars = ''
  modules.forEach((m, i) => {
    if (i % 2 === 0) bars += `M${x} 0h${m}v1h-${m}z`
    x += m
  })
  const label = (title ?? text).replace(/[<&"]/g, '')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 1" width="100%" height="100%" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="${label}"><path d="${bars}" fill="#000"/></svg>`
}
