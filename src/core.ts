export interface NicknameConsumerConfig {
  enabled: boolean
  guilds: string[]
  includePrivate: boolean
}

export function consumerApplies(
  config: NicknameConsumerConfig,
  session: { isDirect?: boolean, guildId?: string },
): boolean {
  if (!config.enabled) return false
  if (session.isDirect) return config.includePrivate
  if (!session.guildId) return false
  return config.guilds.length === 0 || config.guilds.includes(session.guildId)
}

export function chooseChatLunaMessageName(
  existing: string | undefined,
  sourceKind: string | undefined,
  managedNickname: string | undefined,
): string | undefined {
  if (existing != null || sourceKind === 'agent-task') return existing
  return managedNickname
}

export function rewriteCharacterMessageNames(
  messages: Array<{ id?: string, name: string }>,
  platform: string,
  lookup: (platform: string, userId: string) => string | undefined,
  excludedUserIds: ReadonlySet<string> = new Set(),
): void {
  for (const message of messages) {
    if (!message.id || message.id === 'task' || excludedUserIds.has(message.id)) continue
    const nickname = lookup(platform, message.id)
    if (nickname) message.name = nickname
  }
}
