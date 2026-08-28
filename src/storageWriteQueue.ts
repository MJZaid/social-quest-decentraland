// -----------------------------------------------------------------------
// Extracted, verbatim, from persistenceManager.ts's original in-file queue -
// same FIFO, same semantics, only the module boundary changed. Now shared by
// every Storage write in the scene: Connections (Storage.player.set),
// Social Points (Storage.player.set), and the Leaderboard mirror
// (Storage.set), so no two writes to Storage - player-scoped or scene-scoped,
// any domain - are ever in flight at the same time from this server process.
// -----------------------------------------------------------------------

/**
 * Global write queue: guarantees this server process never has more than one
 * Storage write in flight at a time, no matter how many players/pairs a
 * single RESULT scan produces, and no matter which persisted domain the
 * write belongs to. Needed because the local preview's Storage mock
 * (sdk-commands' server-storage.json) does a non-atomic, whole-file
 * read-modify-write per call with no locking - two concurrent writes can
 * read the same stale snapshot and the second's write silently clobbers the
 * first's. Chaining every write through one FIFO promise tail serializes
 * them app-side regardless of what the storage backend itself does, so the
 * same protection also holds against production's real backend without
 * needing to assume anything about it.
 *
 * A rejected/failed task can never wedge the queue for later ones: the tail
 * is always advanced via a handler that resolves either way.
 *
 * Never `await` a nested enqueueWrite() call from within a task that is
 * itself running inside enqueueWrite() - that deadlocks, since the outer
 * task's own completion is what the inner task's turn is waiting on. A
 * fire-and-forget `void enqueueWrite(...)` from within an outer task is
 * safe: it schedules the inner task to run right after the outer one
 * finishes, never blocking it.
 */
let saveQueueTail: Promise<unknown> = Promise.resolve()

export function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const runTask = saveQueueTail.then(task)
    saveQueueTail = runTask.then(
        () => undefined,
        () => undefined
    )
    return runTask
}
