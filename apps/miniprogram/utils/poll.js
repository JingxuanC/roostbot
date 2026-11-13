// 前台轮询器（M1 房间消息用）。后端 SSE 本身就是轮询 SQLite 的包装，
// 小程序不支持 EventSource，改用 after 游标轮询同一个 messages 接口即可。
// 页面 onHide 调 pause()、onShow 调 start()，避免后台耗电。
function createPoller(task, options) {
  const interval = (options && options.interval) || 2500
  let timer = null
  let running = false
  let disposed = false

  function schedule() {
    if (disposed || !running) return
    timer = setTimeout(tick, interval)
  }

  function tick() {
    if (disposed || !running) return
    Promise.resolve()
      .then(() => task())
      .catch(() => {})
      .then(schedule)
  }

  return {
    start() {
      if (disposed || running) return
      running = true
      tick()
    },
    pause() {
      running = false
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
    stop() {
      disposed = true
      running = false
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
    isRunning() {
      return running
    }
  }
}

module.exports = { createPoller }
