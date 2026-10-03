import type { SettingUnit } from './types.ts'

export const units = {
  days: { forms: ['день', 'дня', 'дней'], hint: 'В днях' },
  megabytes: { forms: ['МБ', 'МБ', 'МБ'], hint: 'В мегабайтах' },
  files: { forms: ['файл', 'файла', 'файлов'], hint: 'Количество файлов' },
  attempts: { forms: ['попытка', 'попытки', 'попыток'], hint: 'Количество попыток' },
  checks: { forms: ['проверка', 'проверки', 'проверок'], hint: 'Количество проверок' },
  connections: { forms: ['подключение', 'подключения', 'подключений'], hint: 'Количество подключений' },
} as const satisfies Record<string, SettingUnit>
