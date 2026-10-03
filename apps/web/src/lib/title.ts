const SUFFIX = '159.team'

/** Document title: the most specific part first, then the brand — «Аудит | 159.team». */
export function pageTitle(...parts: string[]): string {
  return `${parts.length ? parts.join(' — ') : 'Панель'} | ${SUFFIX}`
}

/** `head` option for a route whose title is just its section name. */
export const titleHead = (...parts: string[]) => () => ({ meta: [{ title: pageTitle(...parts) }] })
