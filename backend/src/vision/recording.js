import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import path from 'path'

// capture.py (vision/vision/capture.py, RECORDING_FILE) reads this file in the
// queue directory once a second and writes no frames while it holds
// {"recording": false}. The file is the whole transport: vision/ has no socket.
export const RECORDING_FILE = 'recording.json'

/**
 * The recording switch as capture.py sees it.
 *
 * Anything but an explicit `"recording": false` reads as recording, the same
 * rule capture.py applies, so the panel never shows a pause the camera is not
 * honouring.
 *
 * @param {string} queueDir
 * @returns {Promise<{ recording: boolean, changedAt: string|null }>}
 */
export async function readRecording(queueDir) {
  let state
  try {
    state = JSON.parse(await fs.readFile(path.join(queueDir, RECORDING_FILE), 'utf8'))
  } catch {
    return { recording: true, changedAt: null }
  }
  const paused = state !== null && typeof state === 'object' && state.recording === false
  return {
    recording: !paused,
    changedAt: typeof state?.changed_at === 'string' ? state.changed_at : null,
  }
}

/**
 * Set the switch. Written to a uniquely named temporary file and renamed into
 * place, so capture never reads half a file and two writes cannot interleave.
 *
 * Throws when the queue directory does not exist: creating it here would hide
 * a mistyped path behind a switch that no camera reads.
 *
 * @param {string} queueDir
 * @param {boolean} recording
 */
export async function writeRecording(queueDir, recording) {
  const state = { recording: Boolean(recording), changed_at: new Date().toISOString() }
  const final = path.join(queueDir, RECORDING_FILE)
  const part = `${final}.${randomUUID()}.part`
  await fs.writeFile(part, JSON.stringify(state))
  try {
    await fs.rename(part, final)
  } catch (err) {
    await fs.rm(part, { force: true })
    throw err
  }
  return { recording: state.recording, changedAt: state.changed_at }
}
