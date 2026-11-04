import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  INSTALL_ALREADY_MESSAGE,
  INSTALL_RECORDED_MESSAGE,
  formatDiskBytes,
  pluginDetailHref,
  pluginInstallBlockReason,
  pluginInstallResultMessage,
  pluginInstallStateBadge,
  pluginInstallStateKind,
  pluginInstallStateLabel,
  pluginInstallableTier,
  pluginPermissionItems,
  pluginTierBadgeText,
  pluginTierKind,
  pluginTierLabel,
  pluginUpdateAvailable,
  safeAssetUrl,
} from '../lib/plugins.js'

test('tier 文案与徽章：A/B/C/D 都有中文名，未知值原样兜底', () => {
  assert.equal(pluginTierLabel('A'), '直接可用')
  assert.equal(pluginTierLabel('b'), '需要授权资源')
  assert.equal(pluginTierBadgeText('B'), 'B 级 · 需要授权资源')
  assert.equal(pluginTierBadgeText('C'), 'C 级 · 需要界面容器')
  assert.equal(pluginTierBadgeText('D'), 'D 级 · 仅桌面')
  assert.equal(pluginTierBadgeText('', ''), '级别未知')
  assert.equal(pluginTierLabel('X', '自定义'), '自定义')
  assert.equal(pluginTierBadgeText('X', '自定义'), 'X 级 · 自定义')

  assert.equal(pluginTierKind('A'), 'ok')
  assert.equal(pluginTierKind('B'), 'accent')
  assert.equal(pluginTierKind('C'), 'warn')
  assert.equal(pluginTierKind('D'), 'warn')
  assert.equal(pluginTierKind('X'), '')
})

test('只有 A/B 级可安装，C/D 给出诚实原因', () => {
  assert.equal(pluginInstallableTier('A'), true)
  assert.equal(pluginInstallableTier('B'), true)
  assert.equal(pluginInstallableTier('C'), false)
  assert.equal(pluginInstallableTier('D'), false)
  assert.equal(pluginInstallableTier(''), false)
  assert.equal(pluginInstallBlockReason('A'), '')
  assert.match(pluginInstallBlockReason('C'), /DSH Web/)
  assert.match(pluginInstallBlockReason('D'), /仅桌面/)
  assert.match(pluginInstallBlockReason('X'), /A\/B/)
})

test('磁盘大小：MB/GB/KB 边界', () => {
  assert.equal(formatDiskBytes(0), '0 B')
  assert.equal(formatDiskBytes(320_000_000), '320 MB')
  assert.equal(formatDiskBytes(1_000_000_000), '1 GB')
  assert.equal(formatDiskBytes(1_500_000_000), '1.5 GB')
  assert.equal(formatDiskBytes(1500), '2 KB')
  assert.equal(formatDiskBytes(-1), '0 B')
  assert.equal(formatDiskBytes(Number.NaN), '0 B')
})

test('权限摘要：预检 requires 优先，卡片 requirements 兜底，空值写「无」', () => {
  const preflight = pluginPermissionItems({
    permissions: { tools: 12, skills: 2, network: ['fallback.example'], panels: 0 },
    requires: {
      network: ['api.tushare.pro', '*.eastmoney.com'],
      credentials: ['tushare'],
      diskBytes: 320_000_000,
      binaries: ['python3'],
      dataMounts: ['bars'],
      panels: 2,
    },
  })
  const byLabel = Object.fromEntries(preflight.map((item) => [item.label, item.value]))
  assert.equal(byLabel['网络域'], 'api.tushare.pro、*.eastmoney.com')
  assert.equal(byLabel['凭据'], 'tushare')
  assert.equal(byLabel['磁盘'], '320 MB')
  assert.equal(byLabel['面板'], '2 个')
  assert.equal(byLabel['数据面'], 'bars')
  assert.equal(byLabel['二进制'], 'python3')
  assert.equal(byLabel['工具'], '12 个')
  assert.equal(byLabel['技能'], '2 个')

  const card = pluginPermissionItems({
    permissions: { tools: 3 },
    requirements: { network: ['api.example.com'], diskBytes: 1_000_000 },
  })
  const cardByLabel = Object.fromEntries(card.map((item) => [item.label, item.value]))
  assert.equal(cardByLabel['网络域'], 'api.example.com')
  assert.equal(cardByLabel['磁盘'], '1 MB')
  assert.equal(cardByLabel['凭据'], '无')

  const empty = pluginPermissionItems({})
  assert.ok(empty.every((item) => item.missing === true))
  assert.deepEqual(
    empty.map((item) => item.label),
    ['网络域', '凭据', '磁盘', '面板', '数据面', '二进制']
  )
})

test('install state 文案：installing 必须写等待沙箱同步，不写已安装成功', () => {
  assert.equal(pluginInstallStateLabel('installing'), '等待沙箱同步')
  assert.equal(pluginInstallStateLabel('installed'), '已安装')
  assert.equal(pluginInstallStateLabel('failed'), '失败')
  assert.equal(pluginInstallStateLabel('disabling'), '停用中')
  assert.equal(pluginInstallStateLabel(''), '状态未知')

  assert.equal(pluginInstallStateBadge('installing'), 'installing · 等待沙箱同步')
  assert.equal(pluginInstallStateKind('installing'), 'warn')
  assert.equal(pluginInstallStateKind('installed'), 'ok')
  assert.equal(pluginInstallStateKind('failed'), 'danger')
  assert.equal(pluginInstallStateKind('disabling'), 'warn')
  assert.equal(pluginInstallStateKind('nope'), '')
})

test('更新可用：服务端布尔值优先，否则比较 latest/version', () => {
  assert.equal(pluginUpdateAvailable({ updateAvailable: true, latest: '1.0.0', version: '1.0.0' }), true)
  assert.equal(pluginUpdateAvailable({ updateAvailable: false, latest: '1.2.0', version: '1.0.0' }), false)
  assert.equal(pluginUpdateAvailable({ latest: '1.2.0', version: '1.0.0' }), true)
  assert.equal(pluginUpdateAvailable({ latest: '1.0.0', version: '1.0.0' }), false)
  assert.equal(pluginUpdateAvailable({ latest: null, version: '1.0.0' }), false)
  assert.equal(pluginUpdateAvailable(null), false)
})

test('安装结果文案：202/200 是「已记录，等待沙箱同步」，重复安装单独说明', () => {
  assert.equal(pluginInstallResultMessage({ install: { state: 'installing' }, next: 'sync' }), INSTALL_RECORDED_MESSAGE)
  assert.equal(
    pluginInstallResultMessage({ alreadyInstalled: true, install: { state: 'installing' } }),
    INSTALL_ALREADY_MESSAGE
  )
  assert.doesNotMatch(INSTALL_RECORDED_MESSAGE, /已安装成功/)
  assert.doesNotMatch(INSTALL_ALREADY_MESSAGE, /已安装成功/)
  assert.match(INSTALL_RECORDED_MESSAGE, /等待沙箱同步/)
})

test('插件详情地址会编码 slug', () => {
  assert.equal(pluginDetailHref('market-center'), '#/plugins/market-center')
  assert.equal(pluginDetailHref('行情 中心'), '#/plugins/%E8%A1%8C%E6%83%85%20%E4%B8%AD%E5%BF%83')
  assert.equal(pluginDetailHref(''), '#/plugins')
})

test('图标/截图 URL 白名单：http(s) 与同源路径，拒绝 javascript:/data:/协议相对', () => {
  assert.equal(safeAssetUrl('https://example.com/icon.png'), 'https://example.com/icon.png')
  assert.equal(safeAssetUrl('HTTP://example.com/icon.png'), 'HTTP://example.com/icon.png')
  assert.equal(safeAssetUrl('/assets/icon.png'), '/assets/icon.png')
  assert.equal(safeAssetUrl('assets/icon.png'), 'assets/icon.png')
  assert.equal(safeAssetUrl('javascript:alert(1)'), '')
  assert.equal(safeAssetUrl('data:image/png;base64,AAAA'), '')
  assert.equal(safeAssetUrl('blob:https://example.com/x'), '')
  assert.equal(safeAssetUrl('//evil.example.com/x.png'), '')
  assert.equal(safeAssetUrl('https://example.com\\@evil.com/x.png'), '')
  assert.equal(safeAssetUrl(''), '')
  assert.equal(safeAssetUrl(null), '')
})
