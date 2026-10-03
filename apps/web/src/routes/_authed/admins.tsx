import { createFileRoute } from '@tanstack/react-router'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@workspace/ui/components/empty'
import { ShieldIcon } from 'lucide-react'
import { PageHeader } from '@/components/page-header'

export const Route = createFileRoute('/_authed/admins')({
  component: () => (
    <div className="flex flex-col gap-6">
      <PageHeader title="Админы" description="Админы панели." />
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldIcon />
          </EmptyMedia>
          <EmptyTitle>Раздел в разработке</EmptyTitle>
          <EmptyDescription>Здесь скоро появится содержимое.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  ),
})
