import * as React from 'react'
import {
  createPaginatedRowModel,
  rowPaginationFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type PaginationState,
  type ReactTable,
  type RowData,
  type TableFeatures,
} from '@tanstack/react-table'
import { Button } from '@workspace/ui/components/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'

// module scope = stable identity (TanStack Table v9)
export const clientTableFeatures = tableFeatures({ rowPaginationFeature, paginatedRowModel: createPaginatedRowModel() })
export const serverTableFeatures = tableFeatures({ rowPaginationFeature })
export type ClientTableFeatures = typeof clientTableFeatures
export type ServerTableFeatures = typeof serverTableFeatures

interface Pager {
  pageIndex: number
  pageCount: number
  canPrev: boolean
  canNext: boolean
  prev: () => void
  next: () => void
}

function TableShell<TFeatures extends TableFeatures, T extends RowData>(props: {
  table: ReactTable<TFeatures, T>
  columnsCount: number
  empty: React.ReactNode
  pager: Pager
}) {
  const { table } = props
  const rows = table.getRowModel().rows
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((header) => (
                  <TableHead key={header.id}>{header.isPlaceholder ? null : <table.FlexRender header={header} />}</TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={props.columnsCount} className="h-24 text-center">
                  {props.empty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {props.pager.pageCount > 1 && (
        <div className="flex items-center justify-end gap-2">
          <span className="text-muted-foreground mr-auto text-sm">
            Страница {props.pager.pageIndex + 1} из {props.pager.pageCount}
          </span>
          <Button variant="outline" size="sm" onClick={props.pager.prev} disabled={!props.pager.canPrev}>
            Назад
          </Button>
          <Button variant="outline" size="sm" onClick={props.pager.next} disabled={!props.pager.canNext}>
            Вперёд
          </Button>
        </div>
      )}
    </div>
  )
}

/** Client-side paginated table on shadcn Table. */
export function DataTable<T extends RowData>(props: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous column value types
  columns: ColumnDef<ClientTableFeatures, T, any>[]
  data: T[]
  pageSize?: number
  empty?: React.ReactNode
}) {
  const [pagination, setPagination] = React.useState<PaginationState>({ pageIndex: 0, pageSize: props.pageSize ?? 20 })
  const table = useTable({
    features: clientTableFeatures,
    columns: props.columns,
    data: props.data,
    state: { pagination },
    onPaginationChange: setPagination,
  })
  return (
    <TableShell
      table={table}
      columnsCount={props.columns.length}
      empty={props.empty ?? 'Нет данных'}
      pager={{
        pageIndex: table.state.pagination.pageIndex,
        pageCount: table.getPageCount(),
        canPrev: table.getCanPreviousPage(),
        canNext: table.getCanNextPage(),
        prev: () => table.previousPage(),
        next: () => table.nextPage(),
      }}
    />
  )
}

/** Server-side paginated table: rows arrive already paginated; page state lives in the URL. */
export function ServerDataTable<T extends RowData>(props: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous column value types
  columns: ColumnDef<ServerTableFeatures, T, any>[]
  data: T[]
  rowCount: number
  pagination: PaginationState
  onPageChange: (pageIndex: number) => void
  empty?: React.ReactNode
}) {
  const table = useTable({
    features: serverTableFeatures,
    columns: props.columns,
    data: props.data,
    manualPagination: true,
    rowCount: props.rowCount,
    state: { pagination: props.pagination },
    onPaginationChange: (updater) => {
      const next = typeof updater === 'function' ? updater(props.pagination) : updater
      props.onPageChange(next.pageIndex)
    },
  })
  return (
    <TableShell
      table={table}
      columnsCount={props.columns.length}
      empty={props.empty ?? 'Нет данных'}
      pager={{
        pageIndex: props.pagination.pageIndex,
        pageCount: table.getPageCount(),
        canPrev: table.getCanPreviousPage(),
        canNext: table.getCanNextPage(),
        prev: () => table.previousPage(),
        next: () => table.nextPage(),
      }}
    />
  )
}
