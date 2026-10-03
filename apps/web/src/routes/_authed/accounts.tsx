import { createFileRoute } from '@tanstack/react-router'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@workspace/ui/components/empty'
import { UsersIcon } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { titleHead } from '@/lib/title'

export const Route = createFileRoute('/_authed/accounts')({
  head: titleHead('Аккаунты'),
  component: () => (
    <div className="flex flex-col gap-6">
      <PageHeader title="Аккаунты" description="Список аккаунтов, импорт tdata и вход по QR." />
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UsersIcon />
          </EmptyMedia>
          <EmptyTitle>Раздел в разработке</EmptyTitle>
          <EmptyDescription>Здесь скоро появится содержимое.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  ),
})
