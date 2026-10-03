import { z } from 'zod'

/** BullMQ queue the api uses to ask the worker to act on accounts and proxies. */
export const COMMANDS_QUEUE = 'worker-commands'

export const workerCommandSchema = z.discriminatedUnion('type', [
  /** (re)load the account from the database and run it if its status says so */
  z.object({ type: z.literal('account.sync'), accountId: z.string() }),
  /** disconnect and forget the client (pause, delete, proxy change); `logout` ends the Telegram session first */
  z.object({ type: z.literal('account.stop'), accountId: z.string(), logout: z.boolean().default(false) }),
  z.object({ type: z.literal('account.sessions'), accountId: z.string() }),
  z.object({ type: z.literal('account.terminateSession'), accountId: z.string(), hash: z.string().regex(/^-?\d+$/) }),
  z.object({ type: z.literal('proxy.check'), proxyId: z.string() }),
  z.object({ type: z.literal('proxy.sync') }),
  z.object({ type: z.literal('qr.start'), qrId: z.string(), proxyId: z.string().nullable(), adminId: z.string().nullable() }),
])

export type WorkerCommand = z.output<typeof workerCommandSchema>
export type WorkerCommandType = WorkerCommand['type']

/** Redis pub/sub channel carrying the 2FA password (or a cancel) to a running QR login; never stored. */
export const qrControlChannel = (qrId: string) => `accs:qr:${qrId}`
export const qrControlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('password'), password: z.string() }),
  z.object({ type: z.literal('cancel') }),
])
export type QrControl = z.output<typeof qrControlSchema>
