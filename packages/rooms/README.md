# @roost/rooms

房间轮次的**纯逻辑**：谁回答、@ 谁能把人提前、限额、何时收轮，以及每个成员这一轮看到的 prompt。
不碰数据库、不碰 HTTP、不引入任何依赖；输入输出都是 `@roost/contract` 里的类型
（`Room` / `RoomMember` / `RoomResponder` / `RoomRound` / `RoundSlot` / `SlotResult` / `ROUND_LIMITS`）。

对应设计：`docs/design/rooms.md` §3–§5、`docs/build/m4-contract.md` §4。

## 文件

| 文件 | 内容 |
|---|---|
| `src/responder.ts` | `resolveResponder`（fallback 链）、`openingSpeakers`（开局 slots）、`parseMentions`（`@名字` / `@all`，中文前缀歧义） |
| `src/round.ts` | `classifyReply`（`[PASS]`）、`createRound`、`startSlot`、`applyMentions`、`advanceSlot`、`nextSlot`、`finishRound`、`turnLimit`、`slotLabel` |
| `src/prompt.ts` | `buildMemberPrompt`（§5 的 9 段）、`buildKickoffPrompt`（建群开场）、`formatLine` |
| `src/index.ts` | 统一导出上面三份 |
| `test/responder.test.ts` | fallback 链、everyone/admin/mentions 开局、`@all` 的 host 门槛、中文名前缀 |
| `test/round.test.ts` | `[PASS]`、@ 提前 / 额外 turn / 上限、`advanceSlot` 不可变、收轮条件 |
| `test/prompt.test.ts` | 9 段顺序与内容、上下文条数上限、位置说明、kickoff |
| `test/helpers.ts` | 测试夹具（不是测试文件） |

## 为什么契约用相对路径导入

仓库目前没有 `node_modules`（没有跑过 `pnpm install`），`node --experimental-strip-types` 也不会解析
workspace 包名，所以本包源码里统一写：

```ts
import type { RoomMember } from '../../contract/src/index.ts'
```

`package.json` 的 `main` / `exports` 仍指向 `./src/index.ts`，装好 workspace 后调用方可以
`import { ... } from '@roost/rooms'`。等 `@roost/contract` 能按包名解析时，只需把这几行 import 换成
`@roost/contract`，API 不变。

## 用法（控制面视角）

```ts
import {
  openingSpeakers, createRound, nextSlot, startSlot,
  buildMemberPrompt, applyMentions, advanceSlot, finishRound, classifyReply
} from './src/index.ts'

// 1) 用户消息 → 开局 slots（顺序即发言顺序）
const speakers = openingSpeakers(room, { text: userText })
const created = createRound({ roomId: room.id, startSeq: seq, slots: speakers })

// 2) 逐个 slot：startSlot → 组装 prompt → 投递 → 结果回来
let round = startSlot(created, nextSlot(created)!)
const prompt = buildMemberPrompt({ room, member, round, earlier, delta, working })

const reply = classifyReply(modelText)            // posted | passed
round = advanceSlot(round, index, reply.kind === 'posted'
  ? { kind: 'posted', text: reply.text }
  : { kind: 'passed' })
if (reply.kind === 'posted') {
  round = applyMentions(round, member, reply.text, {
    callerIsHost: member.role === 'host',
    members: room.members,
    hostBotId: room.hostBotId
  })
}

// 3) 没有下一个 waiting，或 turns 到上限 → 收轮
if (nextSlot(round) === null) round = finishRound(round)
```

实际由 apps/api 落库、apps/runtime 投递；这里只提供决定“投给谁、说什么、算不算说完”的纯函数。

## 语义约定

1. **responder fallback**（rooms.md §4）：
   `member` 指向的成员在房间 → 它；`auto` 的 `fallbackBotId` 在房间 → 它；`everyone` → 全员（host 第一）；
   其他情况（`mentions` 的普通消息、未配置、指向的成员已离开）→ **第一个成员**；没有成员 → `[]`。
   `openingSpeakers` 对 `mentions` 额外按“没人 @ 时默认 lead”处理，lead 取 host（host 不在首位也取 host），
   没有 host 才取第一个成员。
2. **`@all`**：只有调用者是 host 才展开为全员；普通成员的 `@all` 忽略（防 @ 风暴）。开局时用户视为 host，
   所以用户在 `mentions` 房间里写 `@all` 会叫全员。
3. **@ 链**：被 @ 的成员还在后面排队 → 抽出来插到当前 slot 之后（不消耗额外 turn 预算）；
   已经说过 → 名额允许时给一次额外 turn。名额按**被叫的人**算：host 用 `hostTurns`，其他成员用
   `perMemberTurns`；每次 `applyMentions`（即一条回复里的所有 @）可新增的 turn 数按**叫人的一方**算：
   host 用 `hostExtraTurns`，否则 `extraTurns`。整轮的兜底上限见第 6 条的 `turnLimit`。
4. **@ 能解析谁**：候选人是 `applyMentions` 的 `options.members`（房间全量成员）与本轮 slots 的并集。
   因为 `mentions`/`member` 模式下 slots 里可能只有一两个人，控制面必须把房间全量成员传进来，
   否则回复里 @ 不到还没排队的人。省略 `options.members` 时只能 @ 到本轮 slots 里的人。
5. **[PASS]**：`trim()` 后正好是 `[PASS]`（大小写不敏感，也认 `【PASS】`）才算静默；`pass`、空串、
   `[PASS] 后面还有话` 都照常算发言，不吞内容。
6. **状态**：`advanceSlot` 把 `posted/passed/failed/missed/working/approval` 映射到
   `posted/passed/failed/missed/working/waiting-approval`；`turns` 只在该 slot 从 `waiting|speaking`
   第一次被推进时 +1，重复上报不重复计数。越界下标、轮次已结束都原样返回。
7. **收轮**：显式 `stopped` → `stopped`；否则没有 `waiting|speaking`（全部结束）或
   `turns >= turnLimit` → `done`；否则保持 `running`。`done/stopped` 幂等。
   `turnLimit = 出现过的人数 × perMemberTurns + extraTurns + hostExtraTurns`，是兜底阀，不随插入的
   额外 slot 一起抬高；正常轮次由第 3 条的限额先挡住。
8. **prompt**：严格按 §5 的 9 段顺序拼装；空段落省略，但成员清单、发言顺序/位置、行为指令（含 `[PASS]`）
   始终存在。`delta` 只取最后 `deltaMax` 条、`earlier` 只取最后 `earlierMax` 条、公告截到 `noticeMax`。

## 与契约/设计文档的偏差与补充

- `resolveResponder` 的兜底逐字按 §4 的“成员里的第一个”实现（`members[0]`），不额外偏好 host；
  “host 优先”只出现在 `openingSpeakers` 的 `mentions` 默认 lead 和 `everyone` 排序里。
  理由：§4 的 fallback 链与“mentions 没人 @ 时取默认 lead”是两条规则，混在一起会让 `member` 指向的
  成员离开时静默换成 host，与 OMB 的写法不一致。
- `resolveResponder` 对 `everyone` 返回全员（host 第一），不是契约 §4 那句“否则第一个成员”的机械结果：
  `everyone` 的字面意思就是全员，返回一个人会让“谁会回答”提示和实际派发不一致。
- 契约 `Room.replyMode` 仍是 `admin|everyone|mentions`，设计文档的 `responder` 是四模式。两者同时存在时
  **`room.responder.kind` 优先**；只有旧数据没有 responder 时才回落到 `replyMode`（`admin` → 只有 host）。
- 设计里的 `room.bulletin` 在契约里叫 `Room.notice`；prompt 读 `notice`，调用方可以显式传 `notice` 覆盖
  （例如运行时拼好的公告）。字段名以契约为准。
- 契约 §4 只列了 `createRound/advanceSlot/finishRound/applyMentions`。为了让“当前 slot”有确定的锚点、
  并把 `RoomRound.speaking` 填上，额外提供了 `startSlot(round, index)`（waiting → speaking，不占 turns）。
  `applyMentions` 要求调用方在成员开始说话后调它，或者至少让该 slot 的状态不是 `waiting`。
- `[PASS]` 的判定比 ds-bot 的 `isPass` 窄：ds-bot 还认裸 `pass` 和空串，这里按任务约定只认方括号形式，
  避免把正文里的 “pass” 当静默；空回复按 `posted` 原样返回，由调用方决定是否记失败。
  `apps/runtime/room-agent.mjs` 的 `PASS_LIKE` 与本包同一口径（裸 `pass` 不算），它把空串直接归为
  `missed`，所以控制面拿 `classifyReply('')` 时应自己转成 `missed`/失败，不要当成正常发言。
- `applyMentions` 的 `@all` 会给“已经说过的人”一次额外 turn（ds-bot 的行为），只在
  `perMemberTurns/hostTurns` 与额外预算都允许时才插；不想让全员续话时应在房间配置里改用 `member` 模式。
- `finishRound({stopped:true})` 不会改写还没说话的 slot 状态（保持 `waiting`），因为 rooms.md §10 的
  “用户停止”只停当前成员、不终止整轮；UI 需要显式呈现这些 slot。
- prompt 用中文书写（产品语言），`@名字` / `@all` / `[PASS]` 保持字面量；`buildMemberPrompt` 除任务列出的
  参数外还接受可选的 `references`（§5 第 6 段）与 `notice`（覆盖房间公告）。

## 测试

```sh
export PATH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin:$PATH"
node --experimental-strip-types --test packages/rooms/test/*.test.ts
# 或者在本包目录
node --experimental-strip-types --test test/*.test.ts   # 即 npm run check
```
