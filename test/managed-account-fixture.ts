import type { App } from 'koishi'

/** Test setup only: use the same explicit, confirmed association as an admin. */
export async function maintainFixtureIdentity(app: App, platform: string, userId: string, nickname: string) {
  const actor = { platform: 'fixture-admin', userId: 'maintainer', selfId: 'fixture-bot',
    channelId: 'private:maintainer', isDirect: true }
  if (!(await app.database.get('binding', { platform: actor.platform, pid: actor.userId })).length) {
    await app.database.createUser(actor.platform, actor.userId, { authority: 5 })
  }
  const identity = await app.xpPoints.ensureManagedIdentity(platform, userId, nickname)
  const result = await app.xpPoints.accountOperations.rename(actor, identity.profileId, nickname)
  if (result.kind === 'association-required') {
    const group = await app.database.get('xp_identity', { profileId: identity.profileId })
    const proposal = await app.xpPoints.accountOperations.previewAssociation(actor, {
      kind: group.length > 1 ? 'move-account' : 'merge-persons',
      ...(group.length > 1 ? { movedAccountId: identity.accountId } : {}),
      sourceProfileId: identity.profileId, targetProfileId: result.targetProfileId,
      systems: (await app.xpPoints.listScoreSystems()).map(system => ({ systemKey: system.key,
        mode: 'shared' as const, strategy: 'maximum' as const })),
    })
    await app.xpPoints.accountOperations.confirm(actor, proposal.token)
  }
  await app.xpPoints.reload()
  return (await app.xpPoints.getManagedIdentity(platform, userId))!
}
