// 全局入口。启动不做网络请求：登录态由页面 onShow 自行检查，
// 避免冷启动时 token 过期判断与页面跳转竞争。
App({
  globalData: {
    // M1 用：房间消息轮询的 lastSeq 游标，按 roomId 存。
    lastSeq: {}
  }
})
