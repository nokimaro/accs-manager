import { QUEUE_PREFIX } from '@workspace/server'
import { COMMANDS_QUEUE, workerCommandSchema, type WorkerCommand, type WorkerCommandType } from '@workspace/shared/commands'
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq'
import type { WorkerDeps } from './deps.ts'
import { MAINTENANCE_QUEUE, MAINTENANCE_TASKS, SCHEDULE_SETTINGS, schedulePlan, type MaintenanceTask } from './schedule.ts'

export type CommandHandlers = {
  [K in WorkerCommandType]?: (command: Extract<WorkerCommand, { type: K }>) => Promise<unknown>
}
export type MaintenanceHandlers = { [K in MaintenanceTask]?: () => Promise<void> }

export interface WorkerRuntime {
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * Wires the worker's queues: commands from the api (answered through BullMQ results) and maintenance
 * tasks run by BullMQ job schedulers. Feature modules plug in through the handler maps.
 */
export function createWorkerRuntime(
  deps: WorkerDeps,
  handlers: { commands: CommandHandlers; maintenance: MaintenanceHandlers },
  options: { commandConcurrency?: number } = {},
): WorkerRuntime {
  const prefix = deps.queuePrefix ?? QUEUE_PREFIX
  const { logger } = deps
  let maintenanceQueue: Queue | undefined
  const workers: Worker[] = []
  const offs: (() => void)[] = []

  async function applySchedules(): Promise<void> {
    const plan = schedulePlan(deps.settings)
    for (const task of MAINTENANCE_TASKS) {
      await maintenanceQueue!.upsertJobScheduler(task, { every: plan[task] }, { name: task, opts: { removeOnComplete: true, removeOnFail: 50 } })
    }
  }

  async function processCommand(job: Job): Promise<unknown> {
    const parsed = workerCommandSchema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError(`invalid command: ${job.name}`)
    const command = parsed.data
    const handler = handlers.commands[command.type] as ((c: WorkerCommand) => Promise<unknown>) | undefined
    if (!handler) throw new UnrecoverableError(`no handler for ${command.type}`)
    return handler(command)
  }

  async function processMaintenance(job: Job): Promise<void> {
    const handler = handlers.maintenance[job.name as MaintenanceTask]
    if (handler) await handler()
  }

  return {
    async start() {
      maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection: deps.queueRedis, prefix })
      await applySchedules()
      for (const key of SCHEDULE_SETTINGS) {
        offs.push(
          deps.settings.onChange(key, () => {
            applySchedules().catch((err: unknown) => logger.error({ err }, 'worker: re-planning maintenance failed'))
          }),
        )
      }
      const common = { prefix, autorun: true }
      workers.push(
        new Worker(MAINTENANCE_QUEUE, processMaintenance, { ...common, connection: deps.queueRedis.duplicate(), concurrency: 1 }),
        new Worker(COMMANDS_QUEUE, processCommand, { ...common, connection: deps.queueRedis.duplicate(), concurrency: options.commandConcurrency ?? 4 }),
      )
      for (const worker of workers) {
        worker.on('failed', (job, err) => logger.warn({ err, queue: worker.name, job: job?.name }, 'worker: job failed'))
        worker.on('error', (err) => logger.error({ err, queue: worker.name }, 'worker: queue error'))
      }
    },
    async stop() {
      for (const off of offs.splice(0)) off()
      // close() waits for running jobs to finish
      await Promise.allSettled(workers.splice(0).map((w) => w.close()))
      await maintenanceQueue?.close()
    },
  }
}
