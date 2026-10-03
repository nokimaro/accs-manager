import { createFileRoute } from '@tanstack/react-router'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@workspace/ui/components/empty'
import { ScrollTextIcon } from 'lucide-react'
import { PageHeader } from '@/components/page-header'

export const Route = createFileRoute('/_authed/audit')({
  component: () => (
    <div className="flex flex-col gap-6">
      <PageHeader title="Аудит" description="Журнал действий админов и системы." />
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ScrollTextIcon />
          </EmptyMedia>
          <EmptyTitle>Раздел в разработке</EmptyTitle>
          <EmptyDescription>Здесь скоро появится содержимое.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  ),
})
