import { COMMANDS_QUEUE, workerCommandSchema, type WorkerCommand } from '@workspace/shared/commands'
import { Queue, QueueEvents, type Job } from 'bullmq'
import type { Redis } from './redis.ts'

export { COMMANDS_QUEUE }

/** All queues of the project live under this Redis key prefix. */
export const QUEUE_PREFIX = 'accs'

/** Command jobs keep nothing after they finish: payloads may name accounts and sessions. */
const COMMAND_JOB_OPTIONS = { removeOnComplete: true, removeOnFail: true, attempts: 1 } as const

export class WorkerTimeoutError extends Error {
  constructor(type: string) {
    super(`worker did not answer "${type}" in time`)
    this.name = 'WorkerTimeoutError'
  }
}

export interface CommandClient {
  /** fire and forget: the worker picks it up when it can */
  send(command: WorkerCommand): Promise<void>
  /** waits for the worker's answer; throws WorkerTimeoutError when it does not come in `timeoutMs` */
  call<T = unknown>(command: WorkerCommand, timeoutMs?: number): Promise<T>
  close(): Promise<void>
}

/**
 * The api side of the worker commands queue. `connection` must be created with `forQueues`;
 * `prefix` exists for tests that share one Redis.
 */
export function createCommandClient(connection: Redis, prefix = QUEUE_PREFIX): CommandClient {
  const queue = new Queue<WorkerCommand>(COMMANDS_QUEUE, { connection, prefix })
  // QueueEvents blocks on XREAD, so it needs its own connection
  const events = new QueueEvents(COMMANDS_QUEUE, { connection: connection.duplicate(), prefix })
  const ready = events.waitUntilReady()

  const add = (command: WorkerCommand): Promise<Job<WorkerCommand>> =>
    queue.add(command.type, workerCommandSchema.parse(command), COMMAND_JOB_OPTIONS)

  return {
    async send(command) {
      await add(command)
    },
    async call<T>(command: WorkerCommand, timeoutMs = 15_000): Promise<T> {
      await ready
      const job = await add(command)
      try {
        return (await job.waitUntilFinished(events, timeoutMs)) as T
      } catch (err) {
        if (err instanceof Error && /timed out/i.test(err.message)) {
          await job.remove().catch(() => {})
          throw new WorkerTimeoutError(command.type)
        }
        throw err
      }
    },
    async close() {
      await events.close()
      await queue.close()
    },
  }
}
