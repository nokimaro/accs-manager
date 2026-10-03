import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { settingGroups, type SettingGroupId } from '@workspace/shared/settings'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@workspace/ui/components/tabs'
import { z } from 'zod'
import { PageHeader } from '@/components/page-header'
import { SettingsGroupCard } from '@/components/settings/settings-group-card'
import { settingsQueryOptions } from '@/lib/settings'
import { pageTitle } from '@/lib/title'

const groupIds = settingGroups.map((g) => g.id) as [SettingGroupId, ...SettingGroupId[]]

export const Route = createFileRoute('/_authed/settings')({
  validateSearch: z.object({ group: z.enum(groupIds).optional().catch(undefined) }),
  loader: ({ context }) => context.queryClient.query({ ...settingsQueryOptions, staleTime: 'static' }),
  head: ({ match }) => {
    const group = settingGroups.find((g) => g.id === (match.search.group ?? 'telegram'))
    return { meta: [{ title: pageTitle(...(group ? [group.label] : []), 'Настройки') }] }
  },
  component: SettingsPage,
})

function SettingsPage() {
  const { group = 'telegram' } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data } = useSuspenseQuery(settingsQueryOptions)
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Настройки" description="Применяются сразу, без перезапуска. Секреты хранятся зашифрованными и не показываются." />
      <Tabs value={group} onValueChange={(value) => void navigate({ search: { group: value as SettingGroupId }, replace: true })}>
        <div className="overflow-x-auto">
          <TabsList variant="line">
            {settingGroups.map((g) => (
              <TabsTrigger key={g.id} value={g.id}>
                {g.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {settingGroups.map((g) => (
          <TabsContent key={g.id} value={g.id} keepMounted className="pt-4">
            <SettingsGroupCard group={g} data={data} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}
