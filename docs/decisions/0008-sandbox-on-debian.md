# 0008 · The sandbox image on Debian 13

- **Question:** Should the session sandbox image move from Ubuntu 24.04 to
  Debian 13 (trixie), and can its build be made faster?
- **Measured:** this workspace (4 vCPU, egress through a proxy), Docker
  BuildKit, `sandbox/build.sh`, build cache pruned before each cold build.

  | Build | Time | rootfs |
  | --- | --- | --- |
  | Ubuntu 24.04, pip (before), cold | 206 s | 1.7 GB |
  | Debian 13 slim, uv, cold | 114–151 s (two runs) | 1.6 GB |
  | Debian 13, package lists changed, download caches warm | 75 s | 1.6 GB |

  The Debian rootfs passes the whole suite (107 of 107, gVisor suites
  included; `AGENT_DRIVE_ROOTFS` pointed at it) and `sandbox/smoke.sh`
  (all checks; cold start to first exec 80 ms, warm exec 15 ms; 59,794 files).
- **Decision [Johann]:** Debian 13 slim. Python packages install with `uv`
  (kept in the image, so agents have it); apt, uv and npm downloads go to
  BuildKit cache mounts, which speed up rebuilds on one machine (the drive VM)
  and stay out of the image; apt retries failed fetches. CI caches the built
  rootfs (keyed on `sandbox/` and the week), so most CI runs do not build it.
  Node's binaries still come from the `node:22-bookworm` image (official glibc
  builds; they run on trixie).
- **Would change it:** a package the sandbox needs that Debian lacks or ships
  too old; the drive VM's host OS, which is a separate decision (it is still
  Ubuntu 24.04).
