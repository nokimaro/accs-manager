import { expect, type Page } from '@playwright/test'

export const LOGIN = process.env.E2E_LOGIN ?? 'e2e'
export const PASSWORD = process.env.E2E_PASSWORD ?? 'e2e-password-123'

export async function signIn(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login/)
  await page.getByLabel('Логин').fill(LOGIN)
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Войти' }).click()
  await expect(page.getByRole('heading', { name: 'Коды' })).toBeVisible()
}

/** Desktop shows tabs in the header; mobile hides them behind the menu Sheet. */
export async function goToSection(page: Page, name: string, isMobile: boolean): Promise<void> {
  if (isMobile) await page.getByRole('button', { name: 'Открыть меню' }).click()
  await page.getByRole('tab', { name }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
}
