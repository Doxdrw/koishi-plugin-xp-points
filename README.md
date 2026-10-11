# koishi-plugin-xp-points

Koishi 的统一账号与多积分账本服务。插件提供管理昵称、跨平台账号关系、可共享或分账号计分的积分系统、排行榜、周期竞技成绩以及管理员审计工具。它可以独立使用，也可以为其他 Koishi 插件提供 `xpPoints` 服务。

## 安装

在 Koishi 插件市场安装 `xp-points`，或在 Koishi 项目目录执行：

```bash
npm install koishi-plugin-xp-points
```

启用 `database` 服务后加载插件即可。积分系统可以在配置中预置，也可以由管理员或消费插件创建。

## 快速开始

先确认插件已加载 `database` 服务。普通成员可以查询已存在的系统；创建系统和写入积分需要管理员权限（默认分别为 authority 5 和 authority 2，实际权限以 Koishi 配置为准）。

### 普通成员查询

下面的 `event` 是示例系统 key，请替换成实例中实际存在的 key：

```text
积分.查询 event @用户
积分.排行 event
积分.排行 event 月
```

### 管理员建立系统并写入积分

下面的命令用于创建一个群作用域的活动积分系统，并给指定账号增加积分：

```text
积分系统.创建 event guild 活动积分 分
积分.增加 event 1 @用户
```

发送 `xp` 可以查看按权限显示的命令导航，也可以直接使用短命令、点号命令和配置中的业务快捷命令。未配置业务快捷命令时，通用排行命令需要显式写出系统 key；只有绑定了对应系统的快捷命令后，才可以省略 key 使用类似 `积分榜 月` 的形式。

## 文档导航

- 本页：安装、常用命令、账号关系、积分系统和消费插件接入。
- [贡献指南](CONTRIBUTING.md)：本地检查、Pull Request 和 Issue 信息。
- [安全策略](SECURITY.md)：隐私数据和安全问题报告方式。

## 账号与昵称

每个 `(platform, userId)` 对应一个账号，账号可以加入同一个真人档案。真人档案拥有统一管理昵称；账号还可以单独设置标签和显示昵称。账号关系跨积分系统和群生效，积分系统只决定这些账号如何计分。

常用命令：

```text
我的账号
大小号情况 @用户
本群大小号
关联大小号 <@小号> <@主号>
账号模式 共享
账号模式 独立 -r @承接账号
设置主号 @账号
设置账号标签 @账号 小号
设置账号昵称 @账号 昵称
```

`关联大小号` 的第一个参数是要移动的小号，第二个参数是接收方主号。命令先给出影响预览，再由同一操作者在原会话粘贴一次性令牌确认。`--merge-persons` 会把小号原属真人档案的全部账号一起并入主号档案；它控制移动范围，不改变积分合并策略。`--mode`、`--modes`、`--strategies` 和 `--period-strategies` 可分别指定默认计分方式、单系统方式、累计余额策略和周期成绩策略。

完整用法：

```text
用法：关联大小号 <@小号> <@主号>
第一个是要加入的小号，第二个是接收方主号；第二个账号会成为主号。
默认只移动第一个账号；若它原来只有一个账号，则合并该单账号档案。
--merge-persons：把小号原属组的全部账号一起并入主号所在组；决定“移动谁”，不是积分累加。
--mode 共享|独立：统一指定本次全部系统及未来默认计分方式；省略时采用主号所属真人的默认方式。
--modes 系统:共享|独立：单独指定某系统，优先于 --mode；未写的系统沿用本次默认方式。多个系统用逗号分隔。
--strategies 系统:maximum|sum：共享合分取最高（maximum）或累加（sum），不决定移动哪些账号。
--period-strategies 系统:maximum|sum：周期成绩单独选择，默认逐周期取最高；累计累加不会自动累加周期。
--source-keep @原组承接人 / --target-keep @目标组承接人：多账号共享组转独立时指定谁承接原共享余额，其余零分；两个单账号无需填写。
先核对全部系统、全部积分池和负分影响，再在原会话粘贴令牌确认；不是只修改当前群。
用“积分”查看实际系统 key；示例中的 event 需换成该 key。
普通关联：关联大小号 @onebot:123456 @onebot:654321
独立关联：关联大小号 @onebot:123456 @onebot:654321 --mode 独立
整组合并：关联大小号 @onebot:123456 @onebot:654321 --merge-persons
```

共享模式使用一个计分主体，多个账号看到同一余额；独立模式为每个账号分别计分。独立排行榜保留账号自己的昵称，并在小号后标注所属真人；所有条目仍按分数整体排序。账号关系和计分方式的变更都会检查权限、正在使用的账号以及数据版本。

## 积分系统

每个系统创建后固定作用域：

- `global`：跨平台、跨群共用一个积分池。
- `platform`：每个平台各有一个积分池。
- `guild`：按平台和群保存积分池。

管理员可使用 `积分系统` 下的创建、重命名、修改单位、启停、日志和删除命令。删除属于高权限操作，并要求预览和确认。所有余额、流水、账号主体和周期成绩在同一事务中更新；幂等键用于消费插件重试时避免重复记分。

### 周期竞技榜

累计余额不会清零，竞技成绩按日、周、月、年和赛季分别统计。默认采用北京时间（UTC+8，IANA 标识为 `Asia/Shanghai`）。日榜从当地零点开始，周榜从周一开始，月榜和年榜使用自然周期。常用查询形式为：

```text
积分.排行 event 月 2
```

如果已经在 `scoreCommandBindings` 中把某个系统绑定到 `积分榜`，也可以使用以下快捷命令：

```text
积分榜
积分榜 月
积分榜 赛季 2
```

未配置该快捷命令时，请使用带系统 key 的 `积分.排行 event ...`。

也可以使用 `--period` 指定周期、`--date` 指定查询日期、`--season` 指定赛季编号。例如：

~~~text
积分.排行 event --period 月 --date 2026-09-15
积分.排行 event --period 赛季 --season 2026-09
~~~

玩家视图展示排名和成绩；管理员可以在 `积分系统.日志` 中查看周期边界、修订和流水详情。

每套积分系统可以在“周期与赛季”配置中指定共同统计时区，例如：

~~~yaml
scorePeriods:
  event:
    timeZone: Europe/London
~~~

`timeZone` 使用 IANA 时区名称。同一系统的所有榜单按这一时区统计，不同系统可以使用不同地区。时区或赛季规则修改从当前赛季结束后生效；已经保存的周期边界保持固定。

## 群挂靠

群作用域系统可以将多个群映射到同一积分池：

```yaml
scoreGuildAliases:
  event:
    onebot:
      "来源群": "归属群"
```

新系统尚无积分记录时，插件直接采用配置中的挂靠关系。已有余额、流水或周期成绩时，管理员按以下步骤应用变更：

1. 备份数据库，在配置页面修改 `scoreGuildAliases` 并保存，使插件加载新配置。
2. 以 authority 5 权限发送 `积分系统.群挂靠重映射`，查看来源群、归属群及积分变化。
3. 核对预览，在原会话直接发送完整确认令牌。预览后数据变化或令牌过期时，重新预览。

累计余额和周期成绩可以分别选择 `maximum`（逐池取最高）或 `sum`（包含负分的累加）。省略策略时使用配置的默认值，例如：

~~~text
积分系统.群挂靠重映射 maximum maximum
积分系统.群挂靠重映射 sum maximum
积分系统.群挂靠重映射 --balance sum --period sum
~~~

取消某个挂靠时，从配置中删除对应来源群；取消某系统全部挂靠时，可移除该系统的映射配置。确认前仍使用已经应用的关系记分。重映射同时处理各计分主体的累计余额和周期成绩，不作为一次新的竞技奖励。

开发者可使用 `getGuildAliasRemapStatus()` 查看配置与已应用关系，使用 `previewGuildAliasRemap(actor, options)` 和 `confirmGuildAliasRemap(token, actor)` 执行同一预览确认流程。`actor` 包含管理员的 `platform`、`userId`、`selfId`、`channelId`；两次调用使用相同操作者与会话，策略选项为 `balanceStrategy` 和 `periodStrategy`。

## 消费插件接入

消费插件通过账本句柄写入实际账号：

```ts
const ledger = ctx.xpPoints.registerScoreConsumer({
  consumer: 'my-plugin',
  systemKey: config.scoreSystemKey,
  defaultSystem: { key: 'event', name: '活动积分', unit: '分', scope: 'guild' },
})

const identity = await ctx.xpPoints.ensureManagedGuildIdentity(
  session.platform,
  session.userId,
  session.guildId,
  session.username,
)

await ledger.addAccount({ accountId: identity.accountId }, 1, {
  platform: session.platform,
  guildId: session.guildId,
  reason: '完成活动',
  idempotencyKey: `event:${eventId}:${identity.accountId}`,
  actor: { platform: session.platform, userId: session.userId },
})
```

`getAccount`、`addAccount`、`setAccount` 均要求 `{ accountId }`，这样在分账号计分时不会产生目标歧义。消费插件还应为重复请求提供稳定幂等键，并在业务进行期间登记账号占用。

## 隐私与权限

账号关系、管理昵称和积分详情属于管理数据。群聊列表按当前平台和群范围筛选；完整关系与变更预览适合在私聊中进行。删除档案会先生成有界预览，并在确认后与已登记的数据消费方一起提交事务。

## 开发

```bash
npm ci
npm run typecheck
npm test
npm run build
```

本仓库使用 MIT License。贡献方式和安全问题报告流程见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)。

## 支持

使用中遇到可复现的问题，请在 [GitHub Issues](https://github.com/Doxdrw/koishi-plugin-xp-points/issues) 提供插件版本、Koishi/Node.js 版本、最小复现步骤和期望结果。安全问题请按 [安全策略](SECURITY.md) 私下报告，不要公开发布账号、群组、积分明细或令牌。
