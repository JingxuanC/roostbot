// 控制面地址。
//
// 开发期：微信开发者工具「不校验合法域名」已由 project.config.json 的 urlCheck:false 打开，
//         直接连本机 8787；配对码在 http://127.0.0.1:8787/ 的 Web 控制面生成。
// 上线期：改成已 ICP 备案的 HTTPS 域名，并在微信公众平台配置 request 合法域名。
//         注意 server.ts:13 的约束 —— 控制面不得直接暴露公网，必须走反代 + TLS。
const BASE_URL = 'http://127.0.0.1:8787'

module.exports = { BASE_URL }
