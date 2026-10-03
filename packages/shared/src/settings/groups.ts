import type { SettingGroup } from './types.ts'

export const settingGroups = [
  { id: 'telegram', label: 'Telegram', description: 'Профили клиента MTProto: api_id и параметры устройства.' },
  { id: 'notifications', label: 'Уведомления', description: 'Дублирование кодов и предупреждений в Telegram-канал через Bot API.' },
  { id: 'proxy', label: 'Прокси', description: 'Проверка здоровья пула прокси.' },
  { id: 'proxyStore', label: 'proxy-store', description: 'Автосинхронизация прокси с proxy-store.com.' },
  { id: 'worker', label: 'Воркер', description: 'Подключение и обслуживание клиентов аккаунтов.' },
  { id: 'import', label: 'Импорт', description: 'Ограничения при загрузке zip с tdata.' },
  { id: 'retention', label: 'Хранение', description: 'Сколько хранить данные.' },
  { id: 'security', label: 'Безопасность', description: 'Сессии админов и защита входа.' },
] as const satisfies readonly SettingGroup[]
