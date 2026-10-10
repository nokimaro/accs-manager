import * as React from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Button } from '@workspace/ui/components/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@workspace/ui/components/empty'
import { Field, FieldLabel } from '@workspace/ui/components/field'
import { Spinner } from '@workspace/ui/components/spinner'
import { KeyRoundIcon } from 'lucide-react'
import { z } from 'zod'
import { AccountPicker } from '@/components/accounts/account-picker'
import { CodesTable } from '@/components/codes/codes-table'
import { PageHeader } from '@/components/page-header'
import { SetupAlert } from '@/components/setup-alert'
import { accountsQueryOptions, codesFeedQueryOptions } from '@/lib/accounts'
import { useAppEvent } from '@/lib/app-events'
import { titleHead } from '@/lib/title'

const FRESH_MS = 10 * 60_000

export const Route = createFileRoute('/_authed/')({
  head: titleHead('Коды'),
  validateSearch: z.object({ account: z.uuid().optional().catch(undefined) }),
  component: CodesPage,
})

function CodesPage() {
  const { account } = Route.useSearch()
  const navigate = Route.useNavigate()
  const accounts = useQuery(accountsQueryOptions)
  const feed = useInfiniteQuery(codesFeedQueryOptions(account))
  // codes that arrive while the page is open get a «новый» mark (history caught up after a reconnect does not);
  // the list itself refetches on `code.new`
  const [fresh, setFresh] = React.useState<ReadonlySet<number>>(new Set())
  useAppEvent((event) => {
    if (event.type === 'code.new' && Date.now() - Date.parse(event.date) < FRESH_MS) setFresh((prev) => new Set(prev).add(event.id))
  })

  const items = feed.data?.pages.flatMap((p) => p.items) ?? []

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Коды" description="Сообщения от @VerificationCodes всех аккаунтов — новые появляются без перезагрузки страницы." />
      <SetupAlert />
      {accounts.data?.items.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeyRoundIcon />
            </EmptyMedia>
            <EmptyTitle>Кодов пока нет</EmptyTitle>
            <EmptyDescription>Как только появятся аккаунты, новые коды будут приходить сюда без перезагрузки страницы.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" render={<Link to="/accounts" />} nativeButton={false}>
              К аккаунтам
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <Field className="w-full sm:w-80">
              <FieldLabel htmlFor="codes-account">Аккаунт</FieldLabel>
              <AccountPicker
                id="codes-account"
                accounts={accounts.data?.items ?? []}
                value={account ?? null}
                onChange={(id) => void navigate({ search: id ? { account: id } : {} })}
                placeholder="Все аккаунты — поиск по метке, номеру"
              />
            </Field>
          </div>
          {feed.isPending ? (
            <Spinner />
          ) : (
            <CodesTable items={items} showAccount={!account} fresh={fresh} empty={account ? 'У этого аккаунта кодов пока не было' : 'Кодов пока не было'} />
          )}
          {feed.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
                {feed.isFetchingNextPage && <Spinner data-icon="inline-start" />}
                Показать ещё
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
