const api = require('../../utils/api.js')
const auth = require('../../utils/auth.js')
const { BASE_URL } = require('../../utils/config.js')

Page({
  data: {
    code: '',
    loading: false,
    error: '',
    baseUrl: BASE_URL
  },

  onLoad() {
    if (auth.isLoggedIn()) {
      wx.reLaunch({ url: '/pages/rooms/rooms' })
    }
  },

  onCodeInput(e) {
    const digits = String(e.detail.value || '').replace(/\D/g, '').slice(0, 6)
    this.setData({ code: digits, error: '' })
  },

  async onConnect() {
    const code = this.data.code
    if (!/^\d{6}$/.test(code)) {
      this.setData({ error: '请输入 6 位数字配对码' })
      return
    }
    this.setData({ loading: true, error: '' })
    try {
      // 后端 POST /api/pairing/claim → { deviceId, sessionToken, expiresAt }
      const res = await api.claimPairing(code)
      auth.saveSession(res.sessionToken, res.expiresAt)
      wx.reLaunch({ url: '/pages/rooms/rooms' })
    } catch (err) {
      this.setData({ error: (err && err.message) || '连接失败' })
    } finally {
      this.setData({ loading: false })
    }
  }
})
