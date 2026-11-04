// @roost/observability：日志/指标/告警/深度健康的纯函数层（M6-6.6）。
//
// 全部零依赖、可擦除 TS；不读环境变量，不做 I/O。接线位置：
// - apps/api/src/server.ts 的 /metrics 与事件总线：metricsFromEvent
// - /healthz/deep：apps/api/src/health-deep.ts + runHealthChecks
// - 日志落盘前：redactLine；日志轮转：retentionPlan

export * from './from-events.ts'
export * from './alerts.ts'
export * from './health.ts'
export * from './logs.ts'
