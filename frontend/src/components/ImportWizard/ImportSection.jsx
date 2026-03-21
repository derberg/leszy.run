import { useState, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card.jsx'
import { Upload, CheckCircle, AlertCircle, FileText } from 'lucide-react'

export default function ImportSection({ title, description, example, onImport, invalidateKey }) {
  const qc = useQueryClient()
  const [result, setResult] = useState(null)
  const fileRef = useRef()

  const { mutate, isPending } = useMutation({
    mutationFn: async (file) => {
      const fd = new FormData()
      fd.append('file', file)
      return onImport(fd)
    },
    onSuccess: (data) => {
      setResult({ type: 'success', data })
      qc.invalidateQueries({ queryKey: invalidateKey })
    },
    onError: (err) => setResult({ type: 'error', message: err.message }),
  })

  const handleFile = (file) => {
    if (!file) return
    setResult(null)
    mutate(file)
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-apex-muted">{description}</p>

        <details className="text-xs">
          <summary className="cursor-pointer text-apex-muted hover:text-apex-muted flex items-center gap-1">
            <FileText size={11} /> Pokaż przykładowy CSV
          </summary>
          <pre className="mt-2 bg-apex-surface-2 border border-apex-border p-2 text-xs font-mono overflow-x-auto text-apex-muted">
            {example}
          </pre>
        </details>

        <div
          className="border-2 border-dashed border-apex-border-mid py-6 text-center cursor-pointer hover:border-apex-yellow hover:bg-apex-surface/30 transition-colors"
          onClick={() => fileRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]) }}
        >
          <Upload size={20} className="mx-auto text-apex-muted mb-2" />
          <p className="text-xs text-apex-muted">
            {isPending ? 'Importowanie...' : 'Kliknij lub przeciągnij plik CSV'}
          </p>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={e => handleFile(e.target.files[0])}
        />

        {result && result.type === 'success' && (
          <div className="border border-green-300 bg-apex-surface px-3 py-2 text-sm">
            <div className="flex items-center gap-1.5 text-apex-yellow font-semibold mb-1">
              <CheckCircle size={13} /> Import zakończony
            </div>
            <div className="text-xs text-apex-yellow space-y-0.5">
              <div>Zaimportowano: {result.data.imported} · Zaktualizowano: {result.data.updated} · Pominięto: {result.data.skipped}</div>
              {result.data.errors?.length > 0 && (
                <div className="mt-1">
                  <div className="font-semibold text-amber-400">Ostrzeżenia:</div>
                  {result.data.errors.map((e, i) => (
                    <div key={i} className="text-amber-400">Wiersz {e.row}: {e.message}</div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {result && result.type === 'error' && (
          <div className="border border-red-300 bg-apex-surface px-3 py-2 flex items-start gap-1.5 text-sm text-apex-red">
            <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
            {result.message}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
