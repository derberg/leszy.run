import path from 'path'

// queue.py pads frame names to 20 characters so that sorting the directory
// sorts by time. Both sides must agree on the width or no frame is ever found.
const NAME_WIDTH = 20

/**
 * Resolve a crop filename inside a session's queue directory, or refuse.
 *
 * This is the only guard between an admin HTTP route and the rest of the
 * filesystem: the queue directory is typed by an operator and the filename
 * arrives on the wire. The allow-list is narrow on purpose — the reader only
 * ever writes `<sensor_ns>.jpg`, so anything else did not come from it and
 * there is no reason to serve it.
 */
export function safeCropPath(queueDir, name) {
  if (typeof name !== 'string' || !/^\d{1,20}\.jpg$/.test(name)) return null
  const dir = path.resolve(queueDir, 'crops')
  const full = path.resolve(dir, name)
  // Belt and braces: the pattern already excludes a separator, but a resolve
  // check costs nothing and survives someone loosening the pattern later.
  if (path.dirname(full) !== dir) return null
  return full
}

/**
 * Resolve a full frame by its sensor timestamp, or refuse.
 *
 * The timestamp is validated as a plain non-negative integer and then
 * re-formatted by us, so nothing the caller sent ever reaches the path as
 * text.
 */
export function safeFramePath(queueDir, timestamp, { done = false } = {}) {
  if (typeof timestamp !== 'string' || !/^\d{1,20}$/.test(timestamp)) return null
  const name = BigInt(timestamp).toString().padStart(NAME_WIDTH, '0')
  if (name.length > NAME_WIDTH) return null
  const dir = done ? path.resolve(queueDir, 'done') : path.resolve(queueDir)
  return path.resolve(dir, `${name}.jpg`)
}
