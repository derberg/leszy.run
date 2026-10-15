// QR decoder for the bib-office scanner.
//
// Chrome on Android ships a native BarcodeDetector, the same ML Kit decoder
// the phone's camera app uses, so it is preferred. Safari and desktop Firefox
// have none and get the barcode-detector ponyfill, which runs ZXing-C++ as
// WebAssembly. Both replaced html5-qrcode, whose JavaScript port of ZXing
// missed codes that the phone's own camera app read at the bib office.
//
// Vite bundles the .wasm, so it comes from our own origin. The ponyfill would
// otherwise fetch it from jsDelivr at scan time, which needs a CDN the race
// office's connection may not reach and which the CSP does not list.
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

let detectorPromise = null

async function nativeDetector() {
  const Native = globalThis.BarcodeDetector
  if (!Native) return null
  try {
    const formats = await Native.getSupportedFormats()
    return formats.includes('qr_code') ? new Native({ formats: ['qr_code'] }) : null
  } catch {
    return null
  }
}

async function wasmDetector() {
  const { BarcodeDetector, setZXingModuleOverrides } = await import('barcode-detector/ponyfill')
  setZXingModuleOverrides({
    locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
  })
  return new BarcodeDetector({ formats: ['qr_code'] })
}

/** @returns {Promise<{ detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>> }>} */
export function getQrDetector() {
  if (!detectorPromise) {
    detectorPromise = nativeDetector()
      .then(native => native || wasmDetector())
      .catch(err => {
        detectorPromise = null
        throw err
      })
  }
  return detectorPromise
}
