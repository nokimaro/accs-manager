import { expect, test } from '@playwright/test'
import { goToSection, signIn } from './fixtures'

// No Telegram in CI: these check the panel side of proxies, tdata import and QR login up to the first call out.

test('adds a proxy by hand, then deletes it', async ({ page, isMobile }) => {
  const host = `e2e-${Date.now().toString(36)}.example`
  await signIn(page)
  await goToSection(page, 'Прокси', isMobile)
  await page.getByRole('button', { name: 'Добавить', exact: true }).click()
  // toasts are dialogs too: pick the form by its title
  const dialog = page.getByRole('dialog', { name: 'Новый прокси' })
  await dialog.getByLabel('Адрес').fill(host)
  await dialog.getByLabel('Порт').fill('1080')
  await dialog.getByRole('button', { name: 'Добавить', exact: true }).click()
  await expect(dialog).toBeHidden()

  const row = page.getByRole('row').filter({ hasText: host })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: `Действия: ${host}:1080` }).click()
  await page.getByRole('menuitem', { name: 'Удалить' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Удалить' }).click()
  await expect(row).toHaveCount(0)
})

test('tdata import refuses a file that is not a zip', async ({ page, isMobile }) => {
  await signIn(page)
  await goToSection(page, 'Аккаунты', isMobile)
  await page.getByRole('button', { name: 'Добавить аккаунт' }).click()
  const dialog = page.getByRole('dialog', { name: 'Новый аккаунт' })
  await dialog.getByLabel('Архив tdata (.zip)').setInputFiles({ name: 'tdata.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip at all') })
  await dialog.getByRole('button', { name: 'Загрузить и проверить' }).click()
  await expect(dialog.getByText('Не удалось распаковать архив — это точно zip?')).toBeVisible()
})

test('QR login explains that it needs an own api_id', async ({ page, isMobile }) => {
  await signIn(page)
  await goToSection(page, 'Аккаунты', isMobile)
  await page.getByRole('button', { name: 'Добавить аккаунт' }).click()
  const dialog = page.getByRole('dialog', { name: 'Новый аккаунт' })
  await dialog.getByRole('tab', { name: 'По QR-коду' }).click()
  // «напрямую» is never preselected; the request fails before any connection to Telegram anyway
  await dialog.getByLabel('Подключение').click()
  await page.getByRole('option', { name: 'Напрямую, без прокси' }).click()
  await dialog.getByRole('button', { name: 'Показать QR-код' }).click()
  await expect(dialog.getByText('Для входа по QR нужен свой api_id и api_hash (Настройки → Telegram)')).toBeVisible()
})

test('login by phone explains that it needs an own api_id', async ({ page, isMobile }) => {
  await signIn(page)
  await goToSection(page, 'Аккаунты', isMobile)
  await page.getByRole('button', { name: 'Добавить аккаунт' }).click()
  const dialog = page.getByRole('dialog', { name: 'Новый аккаунт' })
  await dialog.getByRole('tab', { name: 'По номеру' }).click()
  await dialog.getByLabel('Подключение').click()
  await page.getByRole('option', { name: 'Напрямую, без прокси' }).click()
  await dialog.getByLabel('Номер телефона').fill('+7 700 123 45 67')
  await dialog.getByRole('button', { name: 'Получить код' }).click()
  await expect(dialog.getByText('Для входа по номеру нужен свой api_id и api_hash (Настройки → Telegram)')).toBeVisible()
})

