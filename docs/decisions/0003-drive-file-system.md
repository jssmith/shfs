# 0003 · The drive's own file system (spike A9)

- **Question:** Can a host daemon serve each session's `/drive` from the store and the session's policy (docs/contracts.md §2) correctly and fast enough to replace the copied session folders? Does fuse-backend-rs give us one implementation for gVisor (`/dev/fuse`) and microVMs (virtio-fs)?
- **Measured:** correctness at the host mount and inside gVisor; speed inside gVisor against a plain bind mount of the same files; whether the same code serves virtio-fs. Details below.
- **Decision:** Keep the daemon and finish it. Do not swap it in yet: five items of work come first (below). Do not fall back to copied directories as the long-term design.
- **Would change it:** a fix for the path-safety item that costs more than about 20% in the benchmarks below; agent sessions finding 3x on `git status` and `rg` too slow in practice; virtio-fs needing a second implementation after all.

## What was built

| Path | What |
| --- | --- |
| `fs/src/drivefs.rs` | The file system: `session_view` ∪ `upper/` − `whiteouts`, reads from blobs, copy-up on write, create, mkdir, unlink, rmdir, rename (including rename-over and directory rename), symlinks, `user.drive.item_id` xattr, one `activity` row per open |
| `fs/src/daemon.rs` | Serving over `/dev/fuse`; kernel cache invalidation; the control socket |
| `fs/src/store.rs`, `view.rs` | Store access (schema compiled in from `server/src/store/schema.sql`), the change probe, the activity writer |
| `fs/src/stub.rs`, `main.rs` | Stub store builder (`agent-drive-fs stub`), `mount`, `hide`, `bump`, `materialize`, `opens` |
| `fs/tests/mount.rs` | 21 tests at the host mount, each run in both cache modes (42) |
| `fs/tests/virtio.rs` | The same `DriveFs` answering FUSE requests from virtqueue descriptor chains |
| `fs/bench/` | Sandbox root file system, OCI bundle, in-gVisor checks, benchmarks, summary |

Run: `cargo test` in `fs/` (root and `/dev/fuse` needed). `bench/make-rootfs.sh`, then `bench/gvisor-check.sh` and `bench/gvisor-bench.sh 7`, then `bench/summarize.py /tmp/a2-gv/bench-work`.

## Design points the spike settled

- **Kernel caching is required.** With zero entry and attribute timeouts every path component is a FUSE request: `rg` over the repository sent about 112,000 requests for 2,100 files (strace of the daemon). With 60 s timeouts, a warm `rg` sends about 4 requests per file (open, read, release, and its share of the directory listings).
- **Freshness with caching.** A cached entry never reaches the daemon, so an epoch check "on every lookup" cannot hide anything. Instead, on an epoch change the daemon diffs the old and new view and sends `FUSE_NOTIFY_INVAL_ENTRY` and `INVAL_INODE` for every changed path the kernel can hold (removed, added, or changed). Three triggers: a **control socket** (`sessions/<dir_id>/control.sock`; the server writes `refresh`, the daemon replies `ok <epoch>` after the kernel has dropped the entries); a 50 ms epoch poll for changes nobody announced; and the per-request check for requests that do arrive. Notifications are never sent from a request handler, because the kernel may hold a directory lock while it waits for that handler.
- **Cheap epoch check.** The SQLite query takes two fcntl locks per call. The daemon first reads the 48-byte WAL-index header from `drive.db-shm` with `pread`, and queries only when it changed (`store::ChangeProbe`, unit-tested across a WAL truncate). Activity rows are written in 20 ms batches, so the daemon's own writes rarely trip the probe.
- **One serving thread.** Four threads were slower: fuse-backend-rs's channels share one non-blocking fd under epoll (a thundering herd), and the file system holds one state lock. Host `cat` of all sympy files took 1.05 s with 4 threads and 0.34 s with 1 (zero timeouts).
- **FLUSH returns ENOSYS**, so the kernel stops sending it (one round trip less per close).

## Correctness

| Where | Result | How |
| --- | --- | --- |
| Host mount, zero timeouts | 21/21 | `cargo test` (`zero_timeouts::*`) |
| Host mount, kernel caching | 21/21 | `cargo test` (`kernel_cache::*`) |
| virtio-fs transport | 1/1 | `cargo test --test virtio` |
| Inside gVisor, zero timeouts | 21/21 checks | `bench/gvisor-check.sh` |
| Inside gVisor, kernel caching | 21/21 checks | `FS_FLAGS="--entry-timeout-ms 60000 --attr-timeout-ms 60000" bench/gvisor-check.sh` |

The tests cover: listing shows the view only (a ringed item stored but not in the view is absent); reads from blobs with no copy-up; symlink rows and writes through them; session symlinks; append and mid-file writes with copy-up (the blob stays unchanged); truncate, chmod; read-only rows refuse writes; create and mkdir (including into store-only directories); unlink and rmdir add whiteouts, and re-created paths start empty; rename of files and directories; **rename-over** (temp file over a store item: new content, no whiteout for the target, shadowed in `upper/`); one `activity` row per open with item id, path and mode; state survives a remount; 500 small files.

**Hide on epoch:** after the view row is deleted and the epoch bumped, the very next `stat` returns ENOENT, the next listing omits the item, a symlink to it dangles, and a handle that was already open gets an error (ENOENT, because the kernel refreshes attributes before the read; or EACCES from the read itself). Hiding a whole directory and un-hiding both apply at once. Inside gVisor, the item is gone on the next `ls` and `stat` even after gVisor's own caches were primed, and a process holding the file open gets `errno 2` on its next read. With kernel caching, "next operation" holds when the server calls the control socket. Without that call, a change is applied within the 50 ms poll (tested, `unannounced_change_is_picked_up`).

## Speed

Inside gVisor (`runsc` release-20261123.0, systrap, no KVM), same sandbox, `--file-access-mounts=shared --network=none`; daemon and plain bind mount of the same files (`agent-drive-fs materialize`); medians of 7 interleaved runs after one warm-up, in ms. Repository: sympy at commit 06e10447 (2,126 files, 47 MB, `.git` included), plus mpmath. The plain default-access column is a separate sandbox without `shared`: that is what the thin drive's copied directory gets today. The host columns use no sandbox.

| Benchmark | gVisor: daemon | gVisor: daemon, zero timeouts | gVisor: plain (shared) | ratio | ratio, zero timeouts | gVisor: plain (default access) | host: daemon | host: plain | host ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `git status` (after an index refresh) | 286 | 1409 | 99 | 2.9x | 14.2x | 72 | 65 | 14 | 4.5x |
| `rg -c 'def '` | 719 | 4669 | 241 | 3.0x | 19.4x | 241 | 145 | 26 | 5.6x |
| `find -type f` | 70 | 202 | 45 | 1.6x | 4.5x | 33 | 83 | 8 | 11.0x |
| `python3 -c 'import sympy'` (611 modules, bytecode cached) | 1256 | 3292 | 1123 | 1.1x | 2.9x | 998 | 431 | 359 | 1.2x |
| 1,000 files × 1 KiB, create and write | 1088 | 1179 | 413 | 2.6x | 2.9x | 193 | 366 | 182 | 2.0x |

- Against today's copied directory (default access), the daemon is 4.0x on `git status`, 3.0x on `rg`, 2.1x on `find`, 1.3x on the import and 5.6x on small-file creation. About half of the small-file gap is shared mode itself (413 against 193 ms on the same plain copy).
- An earlier run without the index refresh (every `git status` re-hashes every file, like a first status in a new session) gave 1,414 ms for the daemon against 428 ms plain (3.3x).
- Small-file creation still costs 8 requests per file: lookup, create, write, `security.capability` getxattr (asked before every write; `HANDLE_KILLPRIV_V2` did not stop it on this kernel), release, getattr, and an ioctl from Python's isatty check.
- **Noise:** the machine was shared with other agents' builds and OCR. Load average was 6 to 9 on 4 CPUs during the runs, so treat absolute numbers as ±30%. Ratios are steadier because runs were interleaved.

## virtio-fs

fuse-backend-rs 0.14.0 serves one `FileSystem` implementation over both transports: `Server::handle_message` takes a `Reader` and `Writer` built either from `/dev/fuse` or from a virtqueue descriptor chain (`Reader::from_descriptor_chain`, `VirtioFsWriter`). `tests/virtio.rs` drives `DriveFs` that way: init, lookup, open, read, an `activity` row, and hide on epoch, through guest memory. Its `vhost-user-fs` feature compiles with the crate (`cargo check --features vhost-user`), but it only adds the DAX cache-request hooks. The vhost-user socket loop itself comes from the `vhost-user-backend` crate, as in other Rust virtio-fs daemons. Not measured: a real microVM (no KVM on this machine). One open point: the kernel invalidation used here goes through `/dev/fuse` and has no virtio-fs equivalent in common guest kernels. A microVM backend would need short timeouts or another way to drop the guest's cache.

## Work before swapping it in

1. **Path safety.** Operations on `upper/` use paths, so a symlink the session places in an intermediate directory could be followed on the host. Use `openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS` from a directory fd, and measure the cost again. This is the blocking item.
2. **Inode lifetime.** `forget` is not implemented: the inode table only grows. Fine for a session, not for long ones.
3. **Server side of the contract:** call the control socket after every epoch bump (proposed below), and read `whiteouts` with re-created paths in mind (a path in both `whiteouts` and `upper/` is a replacement).
4. **Agent soak:** the OpenCode E1 tasks over the daemon, with several sessions at once, and gVisor checkpoint and restore with the FUSE mount (not tried).
5. **Smaller items:** hard links return EPERM; `whiteouts` is append-only and not fsynced; the daemon's memory use was not measured.

## Contract changes proposed (for the lead session's review)

| Change | Why |
| --- | --- |
| §1 and §2: add `sessions/<dir_id>/control.sock`. After incrementing the epoch, the server writes `refresh\n` and waits for `ok <epoch>` (5 s timeout; no daemon, nothing to do) | Kernel caching is needed for speed (up to 6x), and with caching only a synchronous call keeps "gone on the next operation" |
| §2 Freshness: say "the daemon applies an epoch change before it acknowledges `refresh`, and checks the epoch on every request that reaches it" in place of "checks on every lookup and listing" | Cached lookups never reach the daemon |
| Schema: a `mode` (at least the executable bit) on `session_view` or `item_versions` | Executable bits are lost: scripts are not runnable, and `git status` shows mode changes (the benchmarks set `core.fileMode=false`) |
| Schema: `kind = 'dir'` rows in `session_view` | Empty directories cannot be expressed (for example `.git/refs/tags`) |
| §2: what happens to the session's own `upper/` copy of an item that is later ringed or trashed | Today it stays visible to the session. The daemon could hide it if told the copy's origin item |
| §2 Accounting: allow aggregating opens (for example one row per path and mode per minute) | One row per open is about 2,100 rows per `rg` over this repository and about 76,000 rows for one benchmark run |

## gVisor setup used

`runsc` at `/usr/local/bin/runsc`. Benchmarks ran with sidecars copied from the same release into `/tmp/a2-gv/gvisor-bin`. The final check also passed with the sidecars now installed in `/usr/local/bin/gvisor-bin/`. State in `--root /tmp/a2-runsc`. The root file system is a copy of an exported python:3.12-slim image with the host's git and ripgrep added (`bench/make-rootfs.sh`). sympy and mpmath each got the one-line `_version.py` an install would generate, so that a bare checkout imports.
