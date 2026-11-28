# 0003 · The drive's own file system (spike A9)

- **Question:** Can a host daemon serve each session's `/drive` from the store and the session's policy (docs/contracts.md §2) correctly and fast enough to replace the copied session folders? Does fuse-backend-rs give us one implementation for gVisor (`/dev/fuse`) and microVMs (virtio-fs)?
- **Measured:** correctness at the host mount and inside gVisor; speed inside gVisor against a plain bind mount of the same files; whether the same code serves virtio-fs. Details below.
- **Decision:** Keep the daemon and finish it. Do not swap it in yet: five items of work come first (below). Do not fall back to copied directories as the long-term design. **Follow-up 2026-11-25:** the daemon's items are done (see the end); swap it in behind a switch once the server's side is in. **Follow-up 2026-11-28:** the server's side is in, behind `AGENT_DRIVE_FS=daemon` (default `copy`); both modes pass the whole suite.
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

## Follow-up, 2026-11-25 (build/fs-2)

The five items above, plus the contract items for modes and empty directories, and a soak. Run: `cargo test` in `fs/` (root and `/dev/fuse`), `bench/compare.sh <old binary> <new binary>`, `bench/deletes.sh <old> <new>`, `bench/soak.sh 1500`, with `FS_PREFIX=a8` for the names used here. Same machine as above (`runsc` release-20261123.0, systrap, no KVM, 4 CPUs shared with other agents, load 1 to 7).

| Item | Result | Shown by |
| --- | --- | --- |
| Path safety | Every host path in `upper/` is resolved from a directory fd with `openat2(RESOLVE_BENEATH \| RESOLVE_NO_SYMLINKS \| RESOLVE_NO_MAGICLINKS \| RESOLVE_NO_XDEV)`; last names use `*at` calls with no-follow semantics. Cost within noise | `tests/path_safety.rs` (5 tests), `bench/compare.sh` |
| `forget` | Inodes count the kernel's lookups and are dropped when forgotten. 20,000 create/write/rename/delete rounds: the table stays at 2 to 3 inodes (22,002 without `forget`) | `tests/mount.rs` `inode_table_stays_bounded` |
| Hard links | Refused with EPERM, always, before anything is touched. Git falls back to rename | `tests/mount.rs` `hard_links_are_refused` |
| Whiteout durability | Whiteouts are fdatasynced before the reply, after the `upper/` side of the change is synced; a torn last line is dropped | strace below, `bench/deletes.sh`, a unit test |
| Modes, empty directories | Two `contract:` commits (`session_view.mode`, `kind = 'dir'`), implemented in the daemon | `tests/mount.rs` `modes_and_empty_directories` |
| Soak | 25 minutes in gVisor, no failures, daemon RSS 18 to 23 MiB | `bench/soak.sh 1500` |

All tests: 5 unit, 48 at the host mount (24 in each cache mode), 5 path safety, 1 virtio; `bench/gvisor-check.sh` 21/21 inside gVisor in both cache modes.

### Path safety

`fs/src/upper.rs` holds an fd for `upper/`. Lookups use `openat2(O_PATH | O_NOFOLLOW)` and `fstat`; creates use `openat2(O_CREAT | O_EXCL)`; `mkdir -p` opens each component with `openat2` and refuses a symlink in the way; unlink, rmdir, rename, symlink and readlink use the `*at` call on the parent's `O_PATH` fd; chmod is `fchmodat2(AT_SYMLINK_NOFOLLOW)` (EOPNOTSUPP on a symlink); chown and utimens use `AT_SYMLINK_NOFOLLOW`; truncate opens the file with `openat2`. Copy-up unlinks whatever is at its temporary name before creating it with `O_EXCL`, so a planted symlink there is replaced, not written through. In the merged view a non-directory in `upper/` shadows everything below its path (ENOTDIR and ELOOP from the resolution mean "does not exist"). Blobs are opened `O_NOFOLLOW`.

The kernel never asks for a name under a symlink, but a virtio-fs guest kernel or a compromised gVisor sentry can send anything, and a kernel holds inodes from before a directory was swapped. So `tests/path_safety.rs` calls `DriveFs` directly, like such a client:

| Test | Planted in `upper/` | Sent |
| --- | --- | --- |
| `symlink_in_place_of_a_store_directory` | `notes` → target, after inodes for `notes` and its files were looked up | every operation: lookups of every name in the target, getattr, open and read (r, rw), writes (plain, append, truncate), setattr (mode, size, owner, times), readlink, xattrs, link, access, listing, create, mkdir, symlink, mknod, unlink, rmdir, renames in and out, fsyncdir, statfs |
| `symlink_in_place_of_a_session_directory` | the session's own `mine/` and a copied-up `code/src/` → target | the same, on inodes from before |
| `symlink_as_a_last_name` | `notes/todo.txt` → a target file, the copy-up temporary → a target file, `notes/dirlink` → target | reads, writes, create over it, chmod, truncate, times, owner, a copy-up through the temporary, rename and unlink of the link |
| `symlink_planted_under_a_cached_mount` | `notes` → another session, relative, under a real mount with the kernel's caches primed | reads, writes, appends, create, mkdir, unlink, rename, listing, through the kernel |
| `names_with_slashes_or_dots_are_refused` | none | `..`, `.`, `a/b`, `../../etc` as names |

Targets: `/etc`, another session's `upper/` and its whole session directory, and the blob store. Each target is snapshotted (type, mode, owner, size, mtime and content of every entry; `/etc` at its top level) before and after, and compared; replies are checked for the other session's content and for `/etc/passwd`. On `/etc` only lookups, reads and creations of new `a8-planted-*` names are tried, never removals or writes of existing names (a shared machine); the other targets cover the same code paths destructively. The four planting tests fail on the previous build (run with `/etc` left out): lookups under the symlink found inodes, chmod through a leaf symlink succeeded, and the mount test read the other session's file.

Cost, `bench/compare.sh` (both builds mounted in one sandbox, 7 interleaved runs, medians in ms; a = previous build, b = path safety only):

| Benchmark | gVisor a | gVisor b | b/a | zero timeouts a | b | b/a | host a | host b | b/a |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `git status` | 282 | 283 | 1.00 | 1262 | 1304 | 1.03 | 51 | 46 | 0.92 |
| `rg` | 677 | 652 | 0.96 | 4208 | 4020 | 0.96 | 167 | 186 | 1.11 |
| `find` | 95 | 87 | 0.91 | 225 | 235 | 1.04 | 61 | 59 | 0.97 |
| `import sympy` | 1462 | 1472 | 1.01 | 3169 | 3429 | 1.08 | 686 | 637 | 0.93 |
| 1,000 small files | 1446 | 1292 | 0.89 | 1971 | 1986 | 1.01 | 771 | 732 | 0.95 |

Far below the 20% that would have changed the decision: a lookup that misses `upper/` (most of them) is one `openat2` instead of one `lstat`, and a hit is `openat2`, `fstat` and `close`.

The whole branch against the previous build, the same way (b = this branch's final build):

| Benchmark | gVisor a | gVisor b | b/a | zero timeouts a | b | b/a | gVisor plain (shared) | host a | host b | b/a |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `git status` | 360 | 365 | 1.01 | 1560 | 1500 | 0.96 | 102 | 48 | 50 | 1.03 |
| `rg` | 792 | 783 | 0.99 | 4906 | 4873 | 0.99 | 289 | 169 | 176 | 1.04 |
| `find` | 98 | 101 | 1.03 | 258 | 258 | 1.00 | 33 | 60 | 59 | 0.98 |
| `import sympy` | 1535 | 1579 | 1.03 | 3597 | 3540 | 0.98 | 1244 | 651 | 609 | 0.94 |
| 1,000 small files | 1396 | 1437 | 1.03 | 2002 | 2068 | 1.03 | 393 | 717 | 702 | 0.98 |

Absolute numbers moved with the machine's load between runs (`git status` 282, then 360 ms for the same build); the ratios between the two builds are what this compares. Against the plain copy the picture of the first run holds: 3.6x on `git status`, 2.7x on `rg`, 3.1x on `find`, 1.3x on the import, 3.7x on small files.

### `forget`

An inode now carries the kernel's lookup count: replies that hand it out (lookup, create, mkdir, symlink, mknod) add one, `forget` and `batch_forget` subtract, and at zero it is dropped (getattr and setattr no longer allocate counted inodes). A listing (readdir, not readdirplus) hands out inode numbers the kernel never counts or forgets; those are kept for the last 16,384 such names, so a lookup soon after a listing gets the number the listing showed (tested). Numbers are never reused. A forget racing a lookup is safe because the daemon counts a reply before the kernel does.

| Run (both cache modes) | Inodes before | Peak | After |
| --- | ---: | ---: | ---: |
| 20,000 rounds of create, write, read, delete; every 10th also mkdir, rename into it, rmdir | 2 | 3 | 2 to 3 |
| the same without `forget` (stubbed out) | 2 | 20,904 | 22,002 |
| listing 20,000 names placed in `upper/` directly, never looked up | 2 | | 16,387 |

### Hard links

`link` returns EPERM for every source and target, before any copy-up or whiteout. EPERM is what link(2) returns on a file system without hard links (and what the kernel returns when a file system has no `link` operation). Git creates object files with `link()` and falls back to `rename()`; the test runs `git init`, `add`, `commit`, `log` and `status` in the mount. Supporting links would mean two inodes sharing content in a path-based file system, with the kernel's cached size and times of one going stale when the other is written, and the store has no way to record a link. `ln` and `cp -l` report the error; tools that hard-link caches fall back to copying or fail.

### Whiteout durability

| Change | Made durable before the reply, in order |
| --- | --- |
| unlink or rmdir of a store item never written | whiteout line, `fdatasync(whiteouts)` |
| unlink or rmdir of a copied-up item | `unlinkat`, `fsync` of the parent directory in `upper/`, whiteout line, `fdatasync` |
| rename of a store file | copy-up, `renameat`, `fsync` of the moved file and of both directories, whiteout line, `fdatasync` |
| rename of a store directory (its tree is copied up) | copy-up, `renameat`, `syncfs` on `upper/`, whiteout lines, `fdatasync` |
| `fsyncdir` from the session | `fsync` of the directory in `upper/` (it used to do nothing) |

Lines are appended with one `write(2)` on an `O_APPEND` fd; a crash can only tear the last line, of a delete that was not yet acknowledged, and the daemon drops a torn last line when it opens the file (unit test `torn_whiteout_line_is_dropped`). A whiteout never stands without its `upper/` side, so after a crash a delete is either complete or was not acknowledged, and a moved store file is never hidden at its old path while its copy at the new path is still only in the page cache. The order in the daemon, from strace of `rm` of a copied-up file (fd 18 is the parent directory, 6 the whiteouts file, 14 `/dev/fuse`):

```
unlinkat(18, "todo.txt", 0)       = 0
fsync(18)                         = 0
write(6, "notes/todo.txt\n", 15)  = 15
fdatasync(6)                      = 0
writev(14, [...])                 # the reply
```

Cost, `bench/deletes.sh` on the host (ext4 on virtio, kernel caching, medians of 5, ms):

| Operation | before | after | ratio |
| --- | ---: | ---: | ---: |
| `rm -rf` of a store directory never written (`sympy/core`) | 16 | 45 | 2.8x |
| `rm` of 200 copied-up files | 17 | 69 | 4.1x |
| `mv` of 200 store files | 156 | 257 | 1.6x |
| `mv` of a store directory (`sympy/polys`, 201 files) | 53 | 171 | 3.2x |

About 0.15 to 0.3 ms per delete or rename of a store item. Deletes and renames of the session's own files (no whiteout) are unchanged, and none of the five benchmarks above adds whiteouts.

### Modes and empty directories

Proposed as `contract:` commits for the lead session's review: `session_view.mode` (permission bits; NULL: 0644 for a file, 0755 for a directory; `writable = 0` clears a file's write bits) and `kind = 'dir'` rows (a directory that exists with nothing visible in it; directories above other rows need none). The daemon serves both, keeps a file's mode on copy-up, gives directories that copy-up creates in `upper/` the store's mode exactly, treats a mode change like any view change (invalidated on the epoch), skips a 'dir' row where a file row holds the path or a parent, and reads a store without the `mode` column as all NULL (unit test), so it works against the current server. The stub store keeps modes and empty directories when it loads a tree. Over a stub store of the sympy checkout:

| Through the mount | previous build | this branch | source checkout |
| --- | ---: | ---: | ---: |
| `git status --porcelain` entries (core.fileMode on) | 34 | 1 | 1 (an untracked file) |
| executable files | 0 | 47 | 47 |
| empty directories under `.git` | 0 | 3 | 3 |

A store script with mode 0755 runs from the mount; one without the bit gets EACCES (test).

### Soak

`bench/soak.sh 1500`: the daemon with kernel caching (60 s timeouts, the proposed default) mounted into a gVisor sandbox with `--file-access-mounts=shared --network=none`, over a store of the synthetic drive, sympy and mpmath (Git history included) and 25 toggled items. Inside, five workers ran for 25 minutes at once. On the host, a toggler rewrote the toggled rows and bumped the epoch every 0.5 to 2 s (80% announced on the control socket, 20% left to the poll), and a sampler read the daemon's `/proc` status and the control socket's new `stats` every 30 s.

| Worker | What each round checks | Rounds | Failures |
| --- | --- | ---: | ---: |
| git | branch, edit 4 files, add a file, commit, clean status, log, switch back, file gone, delete the branch, clean status; `git fsck` every 10th | 210 (21 fsck) | 0 |
| pytests | 10 modules of mpmath's own test suite, each in its own process, bytecode written to the drive; all must pass | 174 (1,740 modules) | 0 |
| small | 500 files of random content: write, read back and compare hashes, rename half into a subdirectory, compare both listings and contents, delete all | 326 (163,000 files) | 0 |
| renames | directory rename back and forth, editor save (temp, fsync, rename over) with content and listing checks; every 5th round a store directory renamed away and back, file count compared | 121,013 | 0 |
| toggles | while the published state is stable: the listing, the directory's presence and every read agree with it exactly | 52,944 checked (1,090 skipped mid-change) | 0 |

1,124 epoch bumps. At the end, `git fsck` from inside passed with a clean status, the blob store was unchanged (path, size, mtime and mode of every blob), `upper/` held no symlinks, the daemon was still serving, and it unmounted cleanly.

Memory and tables over time (samples every 30 s, about every fourth shown):

| t (s) | RSS (MiB) | peak (MiB) | fds | inodes | open handles | activity rows | epoch bumps |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 7.7 | 7.8 | 18 | 6 | 0 | 0 | 0 |
| 120 | 18.6 | 18.9 | 956 | 3,339 | 940 | 419,356 | 90 |
| 361 | 21.0 | 21.2 | 931 | 3,774 | 911 | 1,152,781 | 274 |
| 602 | 21.5 | 21.6 | 946 | 4,267 | 927 | 1,993,572 | 463 |
| 844 | 21.3 | 21.8 | 900 | 4,623 | 885 | 2,780,197 | 639 |
| 1,086 | 22.4 | 22.4 | 946 | 4,605 | 923 | 3,522,385 | 821 |
| 1,329 | 22.0 | 22.3 | 949 | 5,278 | 934 | 4,293,094 | 1,000 |
| 1,512 | 23.1 | 23.1 | 937 | 4,993 | 919 | 4,807,969 | 1,124 |

- RSS rose from 18.6 to 23.1 MiB over 23 minutes, with the inode table (mostly listing-only inodes, capped at 16,384). Handles and fds did not grow: about 920 open files throughout, most likely gVisor's gofer holding host fds for its own dentry cache.
- **Accounting volume is the real cost:** 4.8 million `activity` rows in 25 minutes (about 3,200 a second), and `drive.db` grew to 485 MB. The 0003 proposal to aggregate opens is now needed before long sessions.

### Server-side changes needed to swap it in

1. After every epoch bump, write `refresh` to `sessions/<dir_id>/control.sock` and wait for `ok <epoch>` (5 s timeout; no socket, nothing to do). Start the daemon with `--entry-timeout-ms 60000 --attr-timeout-ms 60000`.
2. Merge: read `upper/` without ever following a symlink (the server's own reads of `upper/` have the exposure the daemon had): `lstat`, open with `O_NOFOLLOW` (or `openat2` from an fd for `upper/`), take a symlink as a symlink item. Skip `.a2-copyup`.
3. Merge: a path in both `whiteouts` and `upper/` is a replacement; ignore a last line without a newline while the daemon runs.
4. Do not replace or recreate `upper/` while its daemon runs: the daemon holds an fd for the directory and keeps writing into the one it opened.
5. Modes: `ALTER TABLE session_view ADD COLUMN mode INTEGER` on existing data directories (as `db.ts` does for server tables); keep a version's mode somewhere (for example `item_versions.mode`), fill it from `upper/` at merge (a mode-only change is a new version), and write it into `session_view` (`manager.ts` and `merge.ts` insert the rows).
6. Empty directories: rebuild `session_view` for the new CHECK (the table is derived: drop, create from `schema.sql`, repopulate open sessions), record directories that end up empty at merge, and write them as `kind = 'dir'`. Filter `kind = 'file'` where `session_view` is read for items or paths (`search.ts`, the path sets in `manager.ts`).
7. Accounting: accept aggregated opens (one row per path and mode per interval) and switch the daemon to it; at 3,200 rows a second a long session fills the store.
8. Optional: read `stats` from the control socket for monitoring.

### Recommendation

Swap the daemon in for gVisor sessions, behind a per-environment switch that keeps the copied folders as the default until server items 1 to 4 and 7 are in. The blocking item is fixed at no measurable cost, memory is bounded, deletes are durable, and the soak found no correctness failure under concurrent Git, tests, small-file churn, renames and 1,124 epoch changes. Items 5 and 6 can follow: the daemon reads the current schema, and until then modes and empty directories behave as they do today. Still open: gVisor checkpoint and restore with the FUSE mount (not tried), several sessions with one daemon each under load (one at a time here), and the virtio-fs invalidation question for microVMs.


## Follow-up, 2026-11-28 (fs-daemon-switch): the server's side, behind `AGENT_DRIVE_FS=daemon`

Server items 1 to 4 and 7 above are in. `AGENT_DRIVE_FS=copy` (the default) is unchanged; `daemon` serves each session's `/drive` with this daemon. Two `contract:` commits record the changes in `docs/contracts.md` for the lead session's review.

| Item | What the server does now | Shown by |
| --- | --- | --- |
| Refresh | After every epoch bump, once its transaction commits, writes `refresh` to `control.sock` and waits for `ok <epoch>` (5 s; no socket: nothing to do), in both modes | `fsd.test.ts`, the gVisor hide tests (`held`, `leak`) in daemon mode |
| Lifecycle | One `agent-drive-fs mount` per session (60 s timeouts, `--exit-with-parent`) when its sandbox starts, or for the server's own write to `/drive`; the sandbox gets `sessions/<dir_id>/mnt` at `/drive`; stopped (with a lazy `fusermount3 -u` if needed) when the sandbox goes and on shutdown | every suite in daemon mode; no mount left after the runs (`/proc/mounts`) |
| Ownership | `mount --uid --gid`: store items are reported as the sandbox user's, and everything the daemon creates in `upper/` (and `upper/` itself, the root of `/drive`) is given to it | `tests/mount.rs` `owner_is_the_sandbox_user`; `e2e/image.test.ts` (uid 1000 appends, mkdirs, appends again after a merge) |
| The view | `materialise` writes rows only; after a merge the merged copies leave `upper/` and the merged whiteouts go, through `rebase` on the control socket (or on disk when no daemon runs). Tool caches stay | `fsd.test.ts`, `tests/mount.rs` `rebase_on_the_control_socket` |
| Diff and merge | `upper/` against `session_base`, plus whiteouts (a path or a folder above it) as deletes, with the move detection; a path in both is a replacement (an update) | `fsd.test.ts`, the merge and invariant suites in daemon mode |
| Path safety (R14) | The server never opens anything in `upper/` itself. `agent-drive-fs export` copies its regular files into the session's `state/` (which no sandbox mounts) with a manifest; diff and merge read only that copy. `read` serves the host tools; writes go through the mount with `write` (`openat2`, `RESOLVE_BENEATH \| RESOLVE_NO_SYMLINKS`) | `maintain.rs` `planted_symlinks_are_never_followed`; `fsd.test.ts` and `manager.test.ts` (symlinks planted through the mount) |
| Conflicts | The session's version (from the copy) goes to `/work/conflicts/…` and leaves `upper/` if unchanged since; whiteouts over the drive's version go (`unwhite` keeps the rest of a deleted folder hidden) | `fsd.test.ts`, `shell.test.ts` in daemon mode |
| Accounting | One `activity` row per (path, mode, item) per minute, `detail.count` the opens | `store.rs` unit test, `tests/mount.rs` `opens_are_aggregated`, the benchmark below |

### Tests

| Suite | copy | daemon |
| --- | ---: | ---: |
| `npm test` with the gVisor suites (`AGENT_DRIVE_RUNSC`, `AGENT_DRIVE_ROOTFS`, Debian 13 rootfs from `sandbox/build.sh`) | 107/107 | 107/107 (`AGENT_DRIVE_TEST_FS=daemon`) |
| invariants, 500 random runs (`INVARIANT_RUNS=500`) | | 500 runs, 6,040 steps, 329 merges: pass (106 s) |
| `cargo test` in `fs/` | 11 unit, 54 mount (27 in each cache mode), 5 path safety, 1 virtio | |

The 107 include six new daemon-mode tests (`server/src/sessions/fsd.test.ts`), which run whenever root, `/dev/fuse` and a built `agent-drive-fs` are there. The existing tests that played the sandbox by writing into `upper/` now write into the session's `/drive` on the host (`sessionDrive`: `upper/` in copy mode, the mount in daemon mode); none was weakened or skipped. CI runs the whole suite a second time in daemon mode (job `test-daemon`).

### Speed through the server

`node fs/bench/server-modes.mjs 7`: two server contexts, one per mode, the same synthetic tree of 2,000 Python-like files (1.4 MB) uploaded to each, commands run through `Sessions.run` in gVisor (`--file-access-mounts=shared` in both, as `runsc.ts` always passes), interleaved, timed inside the sandbox; medians of 7 after a warm-up, ms. Same machine as above (4 CPUs, shared, load 0.6 to 2).

| Benchmark | copy | daemon | daemon / copy |
| --- | ---: | ---: | ---: |
| `git status` (a repository the session made: 2,000 files, in `upper/` in both modes) | 63 | 211 | 3.4x |
| `rg -c 'def '` (the store's 2,000 files) | 169 | 535 | 3.2x |
| `find -type f` (the store's files) | 30 | 38 | 1.3x |
| `cat` of every file (the store's files) | 641 | 1306 | 2.0x |
| 1,000 files x 1 KiB, created with `cp` (mostly process start-up in gVisor) | 10552 | 11705 | 1.1x |
| The diff before a checkpoint, on the host (about 5,000 files the session wrote; copy mode also hashes the view's 2,000) | 1935 | 93 | 0.05x |

- Inside the sandbox the ratios match the spike's (2.9x on `git status`, 3.0x on `rg` against a shared-mode copy): the cost is the FUSE round trips, not the server's side.
- The diff before a checkpoint is much faster in daemon mode: one Rust process hashes `upper/`, where copy mode hashes every file of the view in Node. A merge adds the copy of the changed files.
- Accounting: 116,854 opens in 18,164 `activity` rows over the 4.5 minutes of the run (6.4 opens per row), against one row per open before.

### Chosen differently from the brief, and why

- **Host writes go through the mount**, not into `upper/` directly: a direct write would leave the kernel's cached size and times stale for 60 s and would not apply copy-up and whiteout rules (a write onto a deleted folder's path). If no sandbox runs, the server starts the session's daemon for the write; it stops with the next sandbox teardown (idle sweep, shutdown). The daemon counts these as `fs` opens.
- **A `rebase` command on the control socket** (not in the brief): resetting `upper/` and `whiteouts` behind a running daemon would leave its in-memory whiteouts and the kernel's caches wrong. The server asks the daemon (or `agent-drive-fs rebase` when none runs, serialised with daemon start) to drop a copy only if it still has the exported content, so a write after the export survives, and to drop only the whiteout lines it merged, so a delete after the export survives.
- **Copies with a mode other than 0644 stay in `upper/`** after a merge when their content is what the view now serves: the server does not store modes yet (item 5), and removing the copy would lose an executable bit that copy mode keeps.

### Still open

- Items 5 and 6 (modes and empty directories in the server's rows).
- gVisor checkpoint and restore with the FUSE mount; several sessions under load (the invariant suite runs three sessions' daemons at once, without load).
- `/work` is still bind-mounted and written by the server with `fsafe.ts` (`/work/conflicts`, run output): the R14 race applies there in both modes.
- A daemon that dies under a running sandbox is noticed at the next command, which replaces the sandbox; nothing restarts it sooner.
