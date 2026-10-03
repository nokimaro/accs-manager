import { describe, expect, it } from 'vitest'
import { parseProxyLine, parseProxyList, proxyEndpointKey } from '../src/proxies.ts'

describe('parseProxyLine', () => {
  it.each([
    ['socks5://user:pass@1.2.3.4:1080', { type: 'socks5', host: '1.2.3.4', port: 1080, username: 'user', password: 'pass' }],
    ['socks://1.2.3.4:1080', { type: 'socks5', host: '1.2.3.4', port: 1080 }],
    ['http://u:p@proxy.example.com:3128', { type: 'http', host: 'proxy.example.com', port: 3128, username: 'u', password: 'p' }],
    ['1.2.3.4:8080', { type: 'http', host: '1.2.3.4', port: 8080 }],
    ['1.2.3.4:8080:user:p@ss:word', { type: 'http', host: '1.2.3.4', port: 8080, username: 'user', password: 'p@ss:word' }],
    ['user:pass@1.2.3.4:8080', { type: 'http', host: '1.2.3.4', port: 8080, username: 'user', password: 'pass' }],
    ['  http://1.2.3.4:80  ', { type: 'http', host: '1.2.3.4', port: 80 }],
  ])('%s', (line, expected) => {
    expect(parseProxyLine(line, 'http')).toEqual({ ok: true, proxy: expected })
  })

  it('uses the default type only for lines without a scheme', () => {
    expect(parseProxyLine('1.2.3.4:1080', 'socks5')).toEqual({ ok: true, proxy: { type: 'socks5', host: '1.2.3.4', port: 1080 } })
    expect(parseProxyLine('http://1.2.3.4:1080', 'socks5')).toMatchObject({ ok: true, proxy: { type: 'http' } })
  })

  it.each([
    ['ftp://1.2.3.4:21', 'Неизвестная схема ftp — нужна socks5 или http'],
    ['1.2.3.4', 'Ожидается host:port'],
    ['1.2.3.4:0', 'Порт — число от 1 до 65535'],
    ['1.2.3.4:99999', 'Порт — число от 1 до 65535'],
    ['bad host:80', 'Некорректный адрес'],
    ['1.2.3.4:80:user', 'Ожидается host:port:логин:пароль'],
  ])('rejects %s', (line, reason) => {
    expect(parseProxyLine(line, 'http')).toEqual({ ok: false, reason })
  })
})

describe('parseProxyList', () => {
  it('skips blanks and comments, reports errors with line numbers and repeated lines', () => {
    const text = ['# kz pool', 'socks5://u:p@1.1.1.1:1080', '', 'nonsense', '1.1.1.2:3128', 'socks5://u:p@1.1.1.1:1080'].join('\n')
    const result = parseProxyList(text, 'http')
    expect(result.proxies.map((p) => p.line)).toEqual([2, 5])
    expect(result.errors).toEqual([{ line: 4, text: 'nonsense', reason: 'Ожидается host:port' }])
    expect(result.repeated).toEqual([{ line: 6, text: 'socks5://u:p@1.1.1.1:1080' }])
  })

  it('treats the same endpoint with another password as a repeat', () => {
    const result = parseProxyList('1.1.1.1:80:u:a\n1.1.1.1:80:u:b', 'http')
    expect(result.proxies).toHaveLength(1)
    expect(result.repeated).toHaveLength(1)
  })
})

it('proxyEndpointKey identifies type, host, port and login', () => {
  expect(proxyEndpointKey({ type: 'http', host: 'A.example.com', port: 80, username: 'u' })).toBe('http://u@a.example.com:80')
  expect(proxyEndpointKey({ type: 'socks5', host: '1.1.1.1', port: 1080 })).toBe('socks5://1.1.1.1:1080')
})
