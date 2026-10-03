import { parseDuration } from '@workspace/shared/duration'
import type { SettingKey } from '@workspace/shared/settings'
import type { SettingsService } from '@workspace/server'

export const MAINTENANCE_QUEUE = 'maintenance'

export const MAINTENANCE_TASKS = ['proxies.checkDue', 'proxies.sync', 'accounts.refreshProfiles', 'housekeeping'] as const
export type MaintenanceTask = (typeof MAINTENANCE_TASKS)[number]

/** Settings whose change re-plans the schedule. */
export const SCHEDULE_SETTINGS: readonly SettingKey[] = ['proxyStore.syncInterval', 'worker.profileRefreshInterval']

/**
 * How often each maintenance task runs. Proxy checks tick every minute and pick the proxies that are due
 * (proxy.checkInterval, or sooner for failing ones); the rest follow their settings.
 */
export function schedulePlan(settings: Pick<SettingsService, 'get'>): Record<MaintenanceTask, number> {
  return {
    'proxies.checkDue': 60_000,
    'proxies.sync': parseDuration(settings.get('proxyStore.syncInterval')),
    'accounts.refreshProfiles': parseDuration(settings.get('worker.profileRefreshInterval')),
    housekeeping: 60 * 60_000,
  }
}
