import { createFileRoute } from '@tanstack/react-router'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@workspace/ui/components/empty'
import { SettingsIcon } from 'lucide-react'
import { PageHeader } from '@/components/page-header'

export const Route = createFileRoute('/_authed/settings')({
  component: () => (
    <div className="flex flex-col gap-6">
      <PageHeader title="Настройки" description="Типизированные настройки без перезапуска." />
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SettingsIcon />
          </EmptyMedia>
          <EmptyTitle>Раздел в разработке</EmptyTitle>
          <EmptyDescription>Здесь скоро появится содержимое.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  ),
})
