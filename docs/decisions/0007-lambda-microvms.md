# 0007 · Lambda MicroVMs: gVisor, FUSE and the test suite

- **Question:** Can an AWS Lambda MicroVM run what Agent Drive ships (gVisor
  sandboxes, FUSE, the full test suite), so that it can serve as the machine
  the gVisor tests run on, and later perhaps as a sandbox backend (open
  questions Q22, Q24)? At what start time and cost? Raised because CodeBuild's
  on-demand hosts cannot run gVisor (below).
- **Measured:** below, each with how. Region us-east-2, account 277611628110
  (development, synthetic data only), 2026-11-25/26.
- **Decision:** below.
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
