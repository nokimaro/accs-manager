import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { settingGroups, settingsDef, type SettingKey } from '@workspace/shared/settings'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Button } from '@workspace/ui/components/button'
import { TriangleAlertIcon } from 'lucide-react'
import { settingsQueryOptions } from '@/lib/settings'

/** Lists required settings that have no value yet (spec §9: empty required values disable features). */
export function SetupAlert() {
  const { data } = useQuery(settingsQueryOptions)
  if (!data) return null
  const missing = (Object.keys(settingsDef) as SettingKey[]).filter((key) => settingsDef[key].meta.required && !data.items[key]?.isSet)
  if (missing.length === 0) return null
  const groups = settingGroups.filter((g) => missing.some((key) => settingsDef[key].meta.group === g.id))
  return (
    <Alert>
      <TriangleAlertIcon />
      <AlertTitle>Настройка не завершена</AlertTitle>
      <AlertDescription>
        Не заполнено обязательных параметров: {missing.length} ({groups.map((g) => g.label).join(', ')}). Без них часть функций выключена.
      </AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" render={<Link to="/settings" />} nativeButton={false}>
          К настройкам
        </Button>
      </AlertAction>
    </Alert>
  )
}
