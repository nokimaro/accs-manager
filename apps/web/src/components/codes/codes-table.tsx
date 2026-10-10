import type { CodeDto } from '@workspace/shared/accounts'
import { Badge } from '@workspace/ui/components/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { AccountName } from '@/components/accounts/account-name'
import { TimeAgo } from '@/components/time-ago'
import { CopyCodeButton } from './copy-code-button'

/** Messages from @VerificationCodes, newest first. `showAccount` — for the shared feed. */
export function CodesTable({ items, showAccount, empty, fresh }: { items: CodeDto[]; showAccount?: boolean; empty: string; fresh?: ReadonlySet<number> }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Получен</TableHead>
            {showAccount && <TableHead>Аккаунт</TableHead>}
            <TableHead>Код</TableHead>
            <TableHead>Сообщение</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length ? (
            items.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <TimeAgo iso={c.date} />
                    {fresh?.has(c.id) && <Badge>новый</Badge>}
                  </span>
                </TableCell>
                {showAccount && (
                  <TableCell>
                    <AccountName id={c.accountId} account={c.account} />
                  </TableCell>
                )}
                <TableCell>{c.code ? <CopyCodeButton code={c.code} /> : <Badge variant="outline">без кода</Badge>}</TableCell>
                <TableCell className="max-w-xl text-sm whitespace-pre-wrap">{c.text}</TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={showAccount ? 4 : 3} className="text-muted-foreground h-24 text-center">
                {empty}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
