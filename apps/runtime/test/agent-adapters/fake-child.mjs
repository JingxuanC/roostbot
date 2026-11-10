// Fake child_process for transport/CLI tests: streams + exit + kill recording.
// No vendor binary, no network, no real process.

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

export function createFakeChild(options = {}) {
  const child = new EventEmitter()
  child.pid = options.pid ?? 4000
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const stdin = {
    writes: [],
    writableEnded: false,
    destroyed: false,
    write(chunk) {
      stdin.writes.push(String(chunk))
      return true
    },
    end() {
      stdin.writableEnded = true
    },
    on() {
      return stdin
    },
    destroy() {
      stdin.destroyed = true
    },
  }
  child.stdin = stdin
  child.kills = []
  child.kill = (signal) => {
    child.kills.push(signal ?? 'SIGTERM')
    return true
  }
  child.writeStdout = (line) => {
    if (typeof line === 'string') child.stdout.write(line.endsWith('\n') ? line : `${line}\n`)
    else child.stdout.write(`${JSON.stringify(line)}\n`)
  }
  child.writeStderr = (line) => {
    child.stderr.write(`${String(line)}\n`)
  }
  child.emitExit = (code = 0, signal = null) => {
    child.emit('exit', code, signal)
  }
  /** Parsed JSON frames the adapter wrote to stdin. */
  child.frames = () => child.stdin.writes
    .join('')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
  return child
}

/** A spawn stand-in that records every child it hands out. */
export function createFakeSpawn(created = []) {
  return (command, args, options) => {
    const child = createFakeChild({ pid: 5000 + created.length })
    child.command = command
    child.args = args
    child.options = options
    created.push(child)
    return child
  }
}
