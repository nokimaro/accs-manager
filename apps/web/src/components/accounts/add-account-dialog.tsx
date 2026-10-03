import * as React from 'react'
import { Button } from '@workspace/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@workspace/ui/components/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@workspace/ui/components/tabs'
import { PlusIcon } from 'lucide-react'
import { ImportTdataTab } from './import-tdata-tab'
import { PhoneLoginTab } from './phone-login-tab'
import { QrLoginTab } from './qr-login-tab'

export function AddAccountDialog() {
  const [open, setOpen] = React.useState(false)
  // a fresh key per opening: closing drops typed passcodes, uploads and a running QR login
  const [session, setSession] = React.useState(0)
  const close = () => setOpen(false)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setSession((s) => s + 1)
      }}
    >
      <DialogTrigger render={<Button />}>
        <PlusIcon data-icon="inline-start" />
        Добавить аккаунт
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Новый аккаунт</DialogTitle>
          <DialogDescription>Перенос сессии из Telegram Desktop или вход новой сессией — по QR-коду или по номеру телефона.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="tdata" key={session}>
          <TabsList>
            <TabsTrigger value="tdata">Из tdata</TabsTrigger>
            <TabsTrigger value="qr">По QR-коду</TabsTrigger>
            <TabsTrigger value="phone">По номеру</TabsTrigger>
          </TabsList>
          <TabsContent value="tdata" className="pt-4">
            <ImportTdataTab onDone={close} />
          </TabsContent>
          <TabsContent value="qr" className="pt-4">
            <QrLoginTab onDone={close} />
          </TabsContent>
          <TabsContent value="phone" className="pt-4">
            <PhoneLoginTab onDone={close} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
