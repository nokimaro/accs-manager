import { createFileRoute, Link } from '@tanstack/react-router'
import { Button } from '@workspace/ui/components/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@workspace/ui/components/empty'
import { KeyRoundIcon } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { SetupAlert } from '@/components/setup-alert'

export const Route = createFileRoute('/_authed/')({
  component: CodesPage,
})

function CodesPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Коды" description="Коды авторизации из служебного чата Telegram всех аккаунтов — в реальном времени." />
      <SetupAlert />
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
    </div>
  )
}
