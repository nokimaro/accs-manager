import { Link } from '@tanstack/react-router'
import { accountTitle, type CodeDto } from '@workspace/shared/accounts'
import { Badge } from '@workspace/ui/components/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { formatDateTime, formatRelative } from '@/lib/format'
import { CopyCodeButton } from './copy-code-button'

/** Messages from @VerificationCodes, newest first. `showAccount` — for the shared feed. */
export function CodesTable({ items, showAccount, empty }: { items: CodeDto[]; showAccount?: boolean; empty: string }) {
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
                <TableCell className="whitespace-nowrap" title={formatDateTime(c.date)}>
                  {formatRelative(c.date)}
                </TableCell>
                {showAccount && (
                  <TableCell>
                    <Link to="/accounts/$id" params={{ id: c.accountId }} className="hover:underline">
                      {accountTitle(c.account)}
                    </Link>
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
