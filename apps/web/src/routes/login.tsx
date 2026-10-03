import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import type { MeResponse } from '@workspace/shared/api'
import { Alert, AlertDescription } from '@workspace/ui/components/alert'
import { Button } from '@workspace/ui/components/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@workspace/ui/components/card'
import { Field, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { Spinner } from '@workspace/ui/components/spinner'
import { z } from 'zod'
import { PasswordInput } from '@/components/password-input'
import { api, ApiError } from '@/lib/api'
import { authKeys, meQueryOptions } from '@/lib/auth'

const loginSearch = z.object({
  // app-relative only — no open redirects
  redirect: z.string().regex(/^\/(?![/\\])/).optional().catch(undefined),
})

export const Route = createFileRoute('/login')({
  validateSearch: loginSearch,
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.query({ ...meQueryOptions, staleTime: 'static' })
    if (me) throw redirect({ href: search.redirect ?? '/' })
  },
  component: LoginPage,
})

function LoginPage() {
  const search = Route.useSearch()
  const router = useRouter()
  const queryClient = useQueryClient()
  const [login, setLogin] = React.useState('')
  const [password, setPassword] = React.useState('')
  const mutation = useMutation({
    mutationFn: () => api<MeResponse>('/auth/login', { method: 'POST', json: { login, password } }),
    onSuccess: async (me) => {
      queryClient.setQueryData(authKeys.me, me)
      await router.navigate({ href: search.redirect ?? '/' })
    },
  })
  const error = mutation.error instanceof ApiError ? mutation.error.message : mutation.error ? 'Не удалось войти' : null

  return (
    <main className="bg-muted flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>accs-manager</CardTitle>
          <CardDescription>Вход в панель управления</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              mutation.mutate()
            }}
          >
            <FieldGroup>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Field>
                <FieldLabel htmlFor="login">Логин</FieldLabel>
                <Input id="login" autoComplete="username" autoFocus required value={login} onChange={(e) => setLogin(e.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Пароль</FieldLabel>
                <PasswordInput id="password" autoComplete="current-password" required value={password}
                  onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending && <Spinner data-icon="inline-start" />}
                Войти
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
