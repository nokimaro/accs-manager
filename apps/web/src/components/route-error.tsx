import * as React from 'react'
import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { Button } from '@workspace/ui/components/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@workspace/ui/components/empty'
import { FileQuestionIcon, TriangleAlertIcon } from 'lucide-react'
import { isChunkLoadError, reloadAfterStaleChunk } from '@/lib/stale-chunks'

/** Router-wide error screen: instead of a blank page, explain and offer a retry. */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  const staleChunk = isChunkLoadError(error)

  // the code on screen belongs to an older build (deploy, or Vite re-optimizing deps in dev): fetch the current one
  React.useEffect(() => {
    if (staleChunk) reloadAfterStaleChunk()
  }, [staleChunk])

  const retry = () => {
    reset()
    void router.invalidate()
  }

  return (
    <Empty className="min-h-[60svh]">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TriangleAlertIcon />
        </EmptyMedia>
        <EmptyTitle>Не удалось загрузить страницу</EmptyTitle>
        <EmptyDescription>
          {staleChunk ? 'Панель обновилась — обновите страницу, чтобы загрузить новую версию.' : 'Сервер не ответил или произошла ошибка. Попробуйте ещё раз.'}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => window.location.reload()}>Обновить страницу</Button>
          {!staleChunk && (
            <Button variant="outline" onClick={retry}>
              Повторить
            </Button>
          )}
        </div>
      </EmptyContent>
    </Empty>
  )
}

export function RouteNotFound() {
  return (
    <Empty className="min-h-[60svh]">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileQuestionIcon />
        </EmptyMedia>
        <EmptyTitle>Страница не найдена</EmptyTitle>
        <EmptyDescription>Такого адреса в панели нет.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" render={<Link to="/" />} nativeButton={false}>
          На главную
        </Button>
      </EmptyContent>
    </Empty>
  )
}
