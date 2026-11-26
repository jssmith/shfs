# 0007 · Lambda MicroVMs: gVisor, FUSE and the test suite

- **Question:** Can an AWS Lambda MicroVM run what Agent Drive ships (gVisor
  sandboxes, FUSE, the full test suite), so that it can serve as the machine
  the gVisor tests run on, and later perhaps as a sandbox backend (open
  questions Q22, Q24)? At what start time and cost? Raised because CodeBuild's
  on-demand hosts cannot run gVisor (below).
- **Measured:** below, each with how. Region us-east-2, account 277611628110
  (development, synthetic data only), 2026-11-25/26.
- **Decision:** feasible; the build server is to be a MicroVM; as a sandbox backend, only for a hosted service. Below.
- **Would change it:** below.

## Why: CodeBuild's hosts cannot run gVisor

CodeBuild on-demand, `BUILD_GENERAL1_LARGE`, privileged mode, image
`aws/codebuild/standard:7.0`. `deploy/aws/ci.sh smoke` (one `runsc run`,
bounded at 30 s, debug logs) on build `57065a9c`: systrap and ptrace both
exit 137 after 30 s. `runsc` fails about 0.1 s after start, then hangs
destroying the container: `Error killing gofer: cannot open pidfd ...: function
not implemented`. No `pidfd_open` means a host kernel before 5.3; the cgroup
paths (`/sys/fs/cgroup/net_cls`, `.../memory`) are cgroup v1. The three gVisor
end-to-end tests had timed out at 60 s each in build `388d28c1` for the same
reason. CodeBuild does not let a project choose the host kernel.

## What was run

`deploy/aws/microvm-spike/`: `make-artifact.sh` builds a zip with one
Dockerfile, two stages: the sandbox rootfs from `sandbox/Dockerfile` (stage
`sandbox`), then the Lambda-managed Amazon Linux 2023 base with `runsc`
20261123.0, Node 22, `poppler-utils`, the repository at HEAD (built), and that
rootfs. `spike.sh` runs on the MicroVM's run hook and prints to stdout, which
the execution role ships to CloudWatch (`/aws/lambda-microvms/agent-drive-spike`).
`roles.yaml` holds the build and execution roles (stack
`agent-drive-microvm-spike`). Image options: `additionalOsCapabilities: ALL`,
baseline 8 GB (x86) or the 2 GB default (Arm, run 1).

## Results

| | Local baseline | MicroVM run 1 (Arm, 1.0) | MicroVM run 2 (x86 and Arm, 2.0) |
| --- | --- | --- | --- |
| Where | this workspace, `docker run --privileged` of the same image | `RunMicrovm` | `RunMicrovm`, one of each |
| Kernel | 6.18.44 | 6.1.189 AL2023 `aarch64.microvm` | 6.1.189 AL2023 `x86_64.microvm` / `aarch64.microvm` |
| CPUs, memory seen | 4, 15 GB | 4, 8 GB (2 GB baseline, 4x peak) | 16, 32 GB (8 GB baseline, 4x peak) |
| `RunMicrovm` to run hook | — | 1.2 s | 1.3 s / 1.3 s |
| Capabilities, uid | all, 0 | all (`CapEff 000001ffffffffff`), 0 | same |
| `/dev/fuse` opens rw | yes | yes | yes |
| `/dev/kvm` | no | no | no |
| cgroups | — | v2; `runsc` fails: `write cgroup.subtree_control: device or resource busy` | fixed by moving processes into a child cgroup first |
| `runsc` smoke (systrap) | pass, < 1 s | fail (cgroup) | **pass, 4 s / 3 s** |
| Test suite | 93 pass, 1 fail, 7 skip; 33 s | not reached | 92 pass, 2 fail, 7 skip; 21 s / 24 s |
| Failures | PDF preview: no `pdftoppm` in the image (fixed in 2.0) | | `runsc exec`: `creating fd map: duplicating payload files: too many open files`, in the leak suite on v2 and v3 |

The "leaked quokkasecret" assertion in run 2 is the exec error echoing the
command, which contains the search term; no item content reached the agent.

### Runs 3 to 5: the open-files limit, and speed

| Run (x86) | Image | Open files | Smoke | Suite | Notes |
| --- | --- | --- | --- | --- | --- |
| 3 | 3.0 | 1048576 | pass, 5 s | no output for 6 min, stopped | output was buffered to the end, so where it hung is unknown |
| 4 | 4.0, first start | 65536 | pass, 11 s | 85 pass, 9 fail, 7 skip; 266 s | all gVisor e2e suites pass except `leak` (4 × MCP request timeout at 60 s); 4 unit tests time out at 5 s; one `listen EACCES` on a session socket; invariants test 85 s (run 2: 14 s) |
| 5 | 4.0, second start | 65536 | pass, 1 s | same unit timeouts; invariants 84 s | not a cold start: the same image started again behaves the same |

The container starts with 1024 open files (soft and hard); `fs.nr_open` is
1073741816. Locally (hard limit 20000) the limit makes no difference to 200
process starts from bash, Node or Python (220–330 ms at each limit). The
invariants test starts no processes and is still 6x slower than in run 2, so
the open-files limit alone does not explain runs 4 and 5; less CPU does.
Run 6 (image 5.0) times a CPU loop at start and end and process starts at
1024, 8192 and 65536, then runs the suite at 8192. Locally the CPU loop is
486 ms.

### Run 6: the MicroVM starts slow and speeds up

Image 5.0, x86, open files 8192 for the suite. `SPIKE-BENCH` lines:

| Measure | Local | MicroVM |
| --- | --- | --- |
| CPU loop (Node, 3×10⁸ iterations), at start | 486 ms | **2218 ms** |
| CPU loop, at the end (about 4.5 min later) | — | **457 ms** |
| 200 process starts, bash / Node / Python, at 1024 | 222 / 294 / 272 ms | 205 / 218 / 186 ms |
| same at 8192 | 226 / 295 / 247 ms | 152 / 207 / 183 ms |
| same at 65536 | (capped at 20000) | 151 / 212 / 185 ms |
| Suite | 93 pass, 1 fail, 33 s | 84 pass, 10 fail, 260 s |

The open-files limit does not change process start cost. The CPU does: about
4.5x slower at start, full speed by the end. All ten failures are timeouts
(vitest's 5 s per test, the MCP client's 60 s per request) in the slow stretch;
the gVisor suites `e2e`, `held`, `image` and `shell` pass, `leak` times out.
The likely cause, not yet shown: the image's memory snapshot is loaded on first
touch, and the spike did not implement the `/validate` hook that lets Lambda
prefetch what a run uses. Run 2, fast throughout, may have started on a host
that already held the snapshot.

The account allows 8 GB of allocated MicroVM memory per architecture
(quotas `L-20EE1DBE` x86, `L-CD1C0CC4` Arm, adjustable): one 8 GB MicroVM at a
time. A second `RunMicrovm` right after a terminate was refused with
`ServiceQuotaExceededException` until the memory was released (seconds).

Image builds took about 9 minutes per version; each architecture builds once
per chipset generation (Graviton 3 and 4; Ice Lake and Sapphire Rapids), in
parallel.

## Cost

Published rate (Arm, US East N. Virginia, the pricing page's example): $0.0000276944
per vCPU-second and $0.0000036667 per GB-second at baseline, usage above
baseline billed per second of use. A 4 vCPU / 8 GB MicroVM is about $0.50 an
hour, so a three-minute test run is about 2.5 cents. Image storage $0.08 per
GB-month, one-week minimum; snapshot reads $0.00155 per GB per start. No
charge while nothing runs.

## Decision

1. **Feasible.** A Lambda MicroVM runs gVisor (systrap, both architectures),
   opens FUSE, and passes every gVisor end-to-end suite at least once. Two
   adjustments are needed in the container and are ours to keep: move
   processes into a child cgroup before `runsc` sets up cgroups, and raise the
   open-files limit (1024 is too low for parallel sandboxes; 8192 is enough).
2. **The build server is a MicroVM [Johann].** CodeBuild's hosts cannot run
   gVisor, and the build server must run every test. Before it carries CI:
   - make the CPU fast from the start: implement the `/validate` hook so
     Lambda prefetches what a run touches, and measure again over several
     starts;
   - decide how a push starts a build and how the MicroVM gets the source,
     with GitHub access kept in an AWS-managed connection (no token in the
     MicroVM image).
3. **Sandbox backend: a hosted-service question only.** The open-source drive
   must run on one Linux server anywhere, with no cloud-specific services
   (design repository, tech spec §1). A MicroVM per session may suit a hosted
   service we run; it is not part of the open-source project.
4. Quota request `085b77d4…` raises x86 MicroVM memory to 32 GB (submitted as
   32768; the API's units are inconsistent, see the request).

## Would change it

- `/validate` does not remove the slow start, or speed varies between starts
  by more than the test timeouts allow: then the build server moves to a
  CodeBuild reserved capacity fleet on our own machine image.
- AWS changing the container's cgroup or capability defaults, which the two
  adjustments rely on.

## Resources left

Stack `agent-drive-microvm-spike` (roles, log group with 14-day retention),
images `agent-drive-spike` (Arm, versions 1.0 and 2.0) and
`agent-drive-spike-x86` (1.0 to 5.0), artifacts under `microvm-spike/` in the
artifact bucket. No MicroVM is running. Delete the images and the stack when
the follow-up spike no longer needs them.

## Follow-up: the first builds on the builder MicroVM (2026-11-26)

`deploy/aws/builder`, image `agent-drive-builder` with the `/validate` warm-up
(13–19 s per chipset build). Invariants test time is the speed marker.

| Build | Image | Workers | Invariants | Result |
| --- | --- | --- | --- | --- |
| `39a2a91` | 1.0 | 16 | 20 s | 97 pass, 3 fail: "too many open files" (hard limit 1024) ×2, PDF preview 5.7 s > 5 s |
| `07ade66` | 1.0 | 16 | 69 s | 96 pass, 4 fail: leak suite, every test at the MCP client's 60 s timeout |
| `5f0cfab` | 2.0 | 4 | 76 s | 95 pass, 5 fail: leak suite ×4 at 60 s, one socket test at 7.2 s > 5 s |

- Fixed: the open-files limit (`ci.sh test` raises the hard limit), the PDF test's timeout.
- Capping workers at the 4-vCPU baseline did not help: a single CPU-bound test
  is still 3.5–4x slower on most starts. The slowness is the host, per start.
- The leak suite does not just run slower: on a fast start its four tests take
  16 s in all; on a slow one each waits the full 60 s and fails. A 4x slower
  machine would need about 16 s each. That points to a wait that never ends
  when the server is slow (a race), not to a short timeout. To reproduce
  locally with a CPU quota on the test process.
