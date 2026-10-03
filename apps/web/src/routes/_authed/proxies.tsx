import { createFileRoute } from '@tanstack/react-router'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@workspace/ui/components/empty'
import { NetworkIcon } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { titleHead } from '@/lib/title'

export const Route = createFileRoute('/_authed/proxies')({
  head: titleHead('Прокси'),
  component: () => (
    <div className="flex flex-col gap-6">
      <PageHeader title="Прокси" description="Пул прокси, проверки и синхронизация с proxy-store." />
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <NetworkIcon />
          </EmptyMedia>
          <EmptyTitle>Раздел в разработке</EmptyTitle>
          <EmptyDescription>Здесь скоро появится содержимое.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  ),
})
