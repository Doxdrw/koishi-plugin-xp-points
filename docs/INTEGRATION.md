# 消费插件接入

在消费插件中声明 `xpPoints` 为所需服务，例如 `export const inject = ['xpPoints']`；类型声明由 `import type {} from 'koishi-plugin-xp-points'` 引入。插件也可以通过 `ctx.inject(['xpPoints'], child => { ... })` 可选接入。

## 记分与账号占用

下面的辅助函数可在上述注入作用域中调用。它声明一套群积分系统，并返回业务完成后的记分函数。将 `systemKey` 设为消费插件自己的配置值，系统绑定和默认声明始终使用同一个 key。

```ts
import type { Context, Session } from 'koishi'
import type {} from 'koishi-plugin-xp-points'

export function registerActivityScores(ctx: Context, systemKey: string) {
  const consumer = 'my-activity-plugin'
  const ledger = ctx.xpPoints.registerScoreConsumer({
    consumer,
    systemKey,
    defaultSystem: { key: systemKey, name: '活动积分', unit: '分', scope: 'guild' },
  })
  const accounts = ctx.xpPoints.registerAccountConsumer(consumer)
  ctx.on('dispose', () => {
    accounts.dispose()
    ledger.dispose()
  })

  return async (session: Session, businessId: string) => {
    if (!session.guildId || !businessId.trim()) throw new Error('需要群聊和业务操作编号。')
    const identity = await ctx.xpPoints.ensureManagedGuildIdentity(
      session.platform, session.userId, session.guildId, session.username,
    )
    const { release } = await accounts.acquire([
      { platform: session.platform, userId: session.userId },
    ])
    try {
      return await ledger.addAccount({ accountId: identity.accountId }, 1, {
        platform: session.platform,
        guildId: session.guildId,
        reason: '完成活动',
        idempotencyKey: `event:${businessId}:${identity.accountId}`,
        actor: { platform: session.platform, userId: session.userId },
      })
    } finally {
      release()
    }
  }
}
```

在业务流程确认有资格领奖后调用返回的函数。`businessId` 由业务流程生成并持久保存，同一次操作重试沿用原编号；返回结果的 `deduplicated` 表示是否命中已有结果。如果活动限制每个真人只参加一次，业务入口使用稳定的 `profileId` 核验资格，实际积分仍写入参赛账号的 `accountId`。

上例的占用覆盖记分步骤。对于需要持续多轮的活动，应在参与者确定后取得占用，在活动结束、取消或异常退出的 `finally` 中调用 `release()`。占用期间，涉及这些账号的关系与计分模式调整会被阻止。注销消费方会一并释放其未结束的占用；每个消费方名称在同一服务中唯一。

## 账本与周期成绩

- `getAccount`、`addAccount`、`setAccount` 均接收 `{ accountId }`，服务按该系统的共享／独立方式定位主体。
- `addAccount` 的增量、`setAccount` 的余额差默认计入竞技成绩。`competitive: false` 只调整累计余额；`effectiveAt` 为历史成绩时间戳。提供的时间应处于已经启用统计的范围内，且不能在未来。
- 群作用域传入实际来源 `guildId`，挂靠后的积分池由服务解析；平台作用域传 `platform`，全局作用域共用一池。
- `leaderboardPage()` 查询累计榜；`periodLeaderboard()` 通过 `kind: 'day' | 'week' | 'month' | 'year' | 'season'` 查询周期榜。
- 设置默认系统仅用于首次创建。已有系统的名称、单位、启停通过管理接口或指令调整，作用域保持固定。

## 自存身份数据与删除联动

消费插件若另存了与真人或账号关联的数据，可通过 `registerProfileDataConsumer()` 注册 `name`、`preview(database, scope)` 和 `delete(database, scope)`。预览返回影响条数、摘要和可核验快照；删除回调使用传入的事务数据库，与 XP 删除一同提交或回滚。文件清理放在提交后的 `afterDelete(scope)` 中，缓存也在提交后刷新。

注册函数返回注销回调，应交给 `ctx.on('dispose', unregister)`。管理员可在 `requiredDeletionConsumers` 中填写消费方注册名，确保整档删除时相关插件已加载。业务数据的清理范围应依据传入的 `scope`，而非再次按可变昵称查人。

## 错误与重试

余额和主体调整由服务以事务提交。业务重试沿用原目标及幂等键，避免把失败重试变成新奖励；通知失败也应与奖励结果分开处理。涉及共享／独立模式变化时，旧奖励重试仍按原业务操作识别。
