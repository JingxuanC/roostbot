const api = require('../../utils/api.js')
const auth = require('../../utils/auth.js')

Page({
  data: {
    rooms: [],
    loading: true,
    error: ''
  },

  onShow() {
    if (!auth.isLoggedIn()) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    this.load()
  },

  async load() {
    this.setData({ loading: true, error: '' })
    try {
      // 后端 GET /api/rooms → { rooms: [{ id, name, replyMode, members, ... }] }
      const res = await api.getRooms()
      const rooms = (res && Array.isArray(res.rooms) ? res.rooms : []).map((room) => ({
        id: room.id,
        name: room.name || '(未命名房间)',
        replyMode: room.replyMode || '',
        memberCount: Array.isArray(room.members) ? room.members.length : 0,
        notice: room.notice || ''
      }))
      this.setData({ rooms: rooms })
    } catch (err) {
      if (err && err.status === 401) {
        auth.clearToken()
        wx.reLaunch({ url: '/pages/login/login' })
        return
      }
      this.setData({ error: (err && err.message) || '加载失败' })
    } finally {
      this.setData({ loading: false })
      wx.stopPullDownRefresh()
    }
  },

  onPullDownRefresh() {
    this.load()
  },

  onRoomTap() {
    // M1 才做房间详情；这里如实提示，不伪造消息数据。
    wx.showToast({ title: '房间详情将在 M1 开放', icon: 'none' })
  },

  async onLogout() {
    try {
      await api.logout()
    } catch (err) {
      // 后端不可达也要能退出本地，清掉 token 即可。
    }
    auth.clearToken()
    wx.reLaunch({ url: '/pages/login/login' })
  }
})
