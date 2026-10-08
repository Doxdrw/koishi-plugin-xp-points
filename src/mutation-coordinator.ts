/** One queue owned by xpPoints, shared by all metadata and balance stores. */
export class SubjectWriteCoordinator {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await callback() } finally { release() }
  }
}
