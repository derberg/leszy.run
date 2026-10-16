import { useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { QrCode, Copy } from 'lucide-react'
import { Button } from './ui/button.jsx'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody } from './ui/dialog.jsx'

/**
 * Button that opens a large, scannable QR code for a link, so a volunteer can
 * scan it from the operator's screen instead of receiving it by message.
 *
 * @param {{ url: string, title: string, subtitle?: string }} props
 */
export default function LinkQrButton({ url, title, subtitle }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant="outline" title="Pokaż kod QR" onClick={() => setOpen(true)}>
        <QrCode size={12} />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {subtitle && <DialogDescription>{subtitle}</DialogDescription>}
          </DialogHeader>
          <DialogBody className="flex flex-col items-center gap-4">
            {/* White quiet zone: phone scanners fail on a QR drawn straight onto the dark theme. */}
            <div className="bg-white p-5">
              <QRCodeSVG value={url} size={360} level="M" style={{ width: 'min(360px, 70vw)', height: 'auto' }} />
            </div>
            <div className="flex items-center gap-2 w-full justify-center">
              <span className="text-xs font-mono text-apex-cyan break-all text-center">{url}</span>
              <Button size="sm" variant="outline" title="Kopiuj link" onClick={() => navigator.clipboard.writeText(url)}>
                <Copy size={12} />
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  )
}
