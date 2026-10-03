const CODE_IN_TEXT = /(?<![\d])\d{4,8}(?![\d])/

/** The first `copyText` anywhere in the reply markup (inlineButtonTypeCopy, or the older keyboardButtonCopy). */
function copyTextIn(value: unknown, depth = 0): string | null {
  if (depth > 8 || value === null || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = copyTextIn(item, depth + 1)
      if (found) return found
    }
    return null
  }
  const record = value as Record<string, unknown>
  if (typeof record.copyText === 'string' && record.copyText.trim()) return record.copyText.trim()
  for (const key of Object.keys(record)) {
    const found = copyTextIn(record[key], depth + 1)
    if (found) return found
  }
  return null
}

/**
 * The code of a @VerificationCodes message: what its «Copy Code» button copies, else the first standalone
 * 4–8 digit number of the text («Your code is 575571»), else null (the text is kept anyway).
 */
export function extractCode(text: string, markup: unknown): string | null {
  const fromButton = copyTextIn(markup)
  if (fromButton && fromButton.length <= 32) return fromButton
  return CODE_IN_TEXT.exec(text)?.[0] ?? null
}
