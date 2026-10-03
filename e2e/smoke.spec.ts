import { expect, test } from '@playwright/test'
import { goToSection, LOGIN, signIn } from './fixtures'

test('wrong password shows an error and stays on /login', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Логин').fill(LOGIN)
  await page.getByLabel('Пароль', { exact: true }).fill('definitely-wrong')
  await page.getByRole('button', { name: 'Войти' }).click()
  await expect(page.getByText('Неверный логин или пароль')).toBeVisible()
  await expect(page).toHaveURL(/\/login/)
})

test('deep link survives the login redirect', async ({ page }) => {
  await page.goto('/audit')
  await expect(page).toHaveURL(/\/login\?redirect=%2Faudit/)
})

test('navigates between sections', async ({ page, isMobile }) => {
  await signIn(page)
  for (const section of ['Аккаунты', 'Прокси', 'Аудит', 'Админы', 'Настройки', 'Коды']) await goToSection(page, section, isMobile)
})

test('saves a setting, keeps it after reload, resets it back', async ({ page, isMobile }) => {
  await signIn(page)
  await goToSection(page, 'Настройки', isMobile)
  await page.getByRole('tab', { name: 'Хранение' }).click()
  const panel = page.getByRole('tabpanel', { name: 'Хранение' })
  const input = panel.getByLabel('Хранить коды', { exact: true })
  await input.fill('45')
  await panel.getByRole('button', { name: 'Сохранить' }).click()
  await expect(page.getByText('Сохранено').first()).toBeVisible()
  await page.reload()
  await expect(page.getByRole('tabpanel', { name: 'Хранение' }).getByLabel('Хранить коды', { exact: true })).toHaveValue('45')
  const reloaded = page.getByRole('tabpanel', { name: 'Хранение' })
  await reloaded.getByRole('button', { name: 'Сбросить' }).click()
  await reloaded.getByRole('button', { name: 'Сохранить' }).click()
  await expect(reloaded.getByLabel('Хранить коды', { exact: true })).toHaveValue('30')
})

test('logout returns to the login page', async ({ page }) => {
  await signIn(page)
  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.getByRole('menuitem', { name: 'Выйти' }).click()
  await expect(page).toHaveURL(/\/login/)
  await page.goto('/')
  await expect(page).toHaveURL(/\/login/)
})

test('creates an admin, then disables it', async ({ page, isMobile }) => {
  const login = `e2e${Date.now().toString(36)}`
  await signIn(page)
  await goToSection(page, 'Админы', isMobile)
  await page.getByRole('button', { name: 'Добавить админа' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Логин').fill(login)
  await dialog.getByLabel('Пароль', { exact: true }).fill('long-enough-password')
  await dialog.getByRole('button', { name: 'Создать' }).click()
  const row = page.getByRole('row').filter({ hasText: login })
  await expect(row).toContainText('активен')
  await row.getByRole('button', { name: `Действия: ${login}` }).click()
  await page.getByRole('menuitem', { name: 'Отключить' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Отключить' }).click()
  await expect(row).toContainText('отключён')
})
