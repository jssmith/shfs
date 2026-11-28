# Deployment pipeline

GitHub Actions tests every push and pull request. A pushed version tag on a
commit of `main` reruns the tests, then makes a signed, versioned release in
S3 and deploys it to the dev VM, which has no GitHub access and no long-lived
secrets, through one fixed SSM document. The release process for people:
`docs/releasing.md`. History: decision 0007 (CodeBuild could not run gVisor; a
Lambda MicroVM builder worked but its speed varied 4x between starts).

```
push / pull request ──▶ .github/workflows/ci.yml: ci.sh test (gVisor suites included), Rust tests
tag v* on main ──▶ .github/workflows/release.yml
                   ci.yml again → tag on main? → npm ci, build → ci.sh package
                   │ environment "release": Johann approves the job
                   │ GitHub OIDC token → sts:AssumeRoleWithWebIdentity agent-drive-release-us-east-2
                   │ ci.sh publish: kms:Sign the manifest's digest → manifest.sig
                   ▼
                 s3://agent-drive-artifacts-<account>-<region>/releases/<sha>/  (put-if-absent)
                   │ ssm:SendCommand AgentDrive-Deploy Version=<sha>, tag agent-drive=dev
                   ▼
                 VM: deploy-release.sh (embedded in the document)
                   verify signature (KMS public key) → check sha256 → unpack to
                   /opt/agent-drive/releases/<sha> → setup.sh if provisioning changed →
                   current → releases/<sha> → restart agent-drive → /healthz → or roll back
```

## Files

| File | What |
| --- | --- |
| `../../.github/workflows/ci.yml` | Tests on every push to `main` and every pull request; reused by `release.yml` |
| `../../.github/workflows/release.yml` | On a `v*` tag: CI, then package, sign, upload, deploy |
| `pipeline.yaml` | Stack `agent-drive-pipeline`: bucket, signing key, GitHub OIDC provider, release role, SSM document |
| `dev-vm.yaml` | The VM stack (Debian 13); `ReleaseReadPolicy` lets its instance role read releases and the public key |
| `ci.sh` | Build steps: test, package, publish (sign, upload, deploy, wait) |
| `deploy-release.sh` | VM-side deploy; embedded verbatim in the document |
| `sync-deploy-document.py` | Copies `deploy-release.sh` into `pipeline.yaml`; run it after changing the script |
| `test/test-deploy-release.sh` | Local test of publish and deploy with stub `aws`, `systemctl`, `curl` and a real P-256 key |
| `test/test-release-smoke.sh` | Packages this checkout, deploys it with stubs, and checks the real server's `/healthz` |
| `test/check-deploy-document.py` | The document takes only a sha, embeds the current script, and parses with `sh -n` |
| `test-setup-in-container.sh` | `setup.sh` in a fresh Debian 13 container |

## A release

`releases/<version>/`, version = the commit sha (`BUILD_SOURCE_VERSION`):

| Object | Contents |
| --- | --- |
| `release.tar.zst` | `package.json`, lockfile, `server/` and `cli/` (`dist`, `package.json`, data files from `src/`), production `node_modules`, `deploy/`, `sandbox/`, `RELEASE` |
| `manifest.json` | `format`, `version`, `tag`, `source`, `build_id` and `build_arn` (the workflow run), `built_at`, `node_version`, `archive.{name,sha256,size}`, `setup_sha256`, `provision_sha256` |
| `manifest.sig` | ECDSA P-256 signature (DER) by KMS over the SHA-256 digest of `manifest.json` |

Each object is uploaded with `If-None-Match: *`, and the release role may only make
conditional puts, so a release is never overwritten. A rebuild of the same commit
fails at upload; redeploy an existing release with the document instead. The
manifest goes up last, so a manifest means a complete release.

`provision_sha256` covers what `setup.sh` installs from a release: `setup.sh`
itself, `deploy/aws/systemd/`, `deploy/cloudflare/` and `sandbox/`. The VM reruns
`setup.sh` only when it differs from the last one applied
(`/var/lib/agent-drive/deploy/provision.sha256`). Hashing `setup.sh` alone would
miss a changed unit file or sandbox image.

## On the VM

| Path | What |
| --- | --- |
| `/opt/agent-drive/releases/<sha>/` | Unpacked releases; the last 5 deployed are kept |
| `/opt/agent-drive/current` | Symlink to the running release; switched with an atomic rename |
| `/usr/local/sbin/agent-drive-deploy-release` | The deploy script, written by each run of the document |
| `/var/lib/agent-drive/deploy/` | `provision.sha256`, `previous`, `history`, `lock` |
| `/var/log/agent-drive-deploy.log` | Every deploy's log (SSM shows only the first 2,500 characters) |

`agent-drive.service` runs `/usr/local/bin/agent-drive serve` with
`WorkingDirectory=/opt/agent-drive/current`; the wrapper runs
`/opt/agent-drive/current/server/dist/main.js`. Node resolves the symlink, so a
running server keeps its own release's `node_modules`.

Store migrations: the server migrates `drive.db` when it starts, so the restart
is the migration. Nothing else is needed today. A rollback does not undo a
migration; a release whose migration an older release cannot read needs a
deliberate plan (the schema is in `server/src/store/schema.sql`).

The first deploy also runs `setup.sh` in full: packages, data volume, Node,
`runsc`, `cloudflared`, Ollama, the sandbox rootfs (Docker build) and the units.
Expect 15 to 25 minutes. The build waits up to 40 minutes
(`DEPLOY_WAIT_SECONDS`); if the build times out first, the deploy still finishes
on the VM. Check it with `get-command-invocation` or the log.

The document installs what the script needs before anything else: `zstd`, `jq`
(apt) and the AWS CLI v2 snap (`snap install aws-cli --classic`). The snap is
published by AWS and snapd checks its signature, and Ubuntu's EC2 images already
run snapd (the SSM agent is a snap). The alternative, AWS's zip with a GPG check,
needs AWS's signing key embedded in the document and kept current.

## Order of deployment (the lead, with admin credentials in the dev account)

All commands use `--region us-east-2`; the lead runs them through the AWS
connector, showing each call first.

1. **Pipeline stack** (`pipeline.yaml`): bucket, key, OIDC provider, release
   role, document. Read the change set before running it; bucket and key are
   modified, never replaced.
2. **VM stack** (`dev-vm.yaml`, `PipelineStackName=agent-drive-pipeline`): its
   first boot installs the SSM agent and the AWS CLI; `RunSetup=false` leaves
   the rest to the first release.
3. **A release:** push a version tag on a commit of `main` (`docs/releasing.md`).
   The first deploy runs `setup.sh` (provisioning changed from none).

## Deploying or rolling back by hand

Any release still in the bucket can be deployed again, older ones included:

```sh
aws ssm send-command --region us-east-2 --document-name AgentDrive-Deploy \
  --targets Key=tag:agent-drive,Values=dev --parameters Version=<40-character sha> \
  --comment "roll back"
aws ssm list-command-invocations --region us-east-2 --command-id <id> --details \
  --query 'CommandInvocations[].[InstanceId,Status,CommandPlugins[0].Output]' --output text
```

The release is verified again and unpacked fresh (the running release is only
restarted). To list releases: `aws s3 ls s3://agent-drive-artifacts-277611628110-us-east-2/releases/`.
The `AgentDriveDev` permission set allows `ssm:SendCommand` with
`AWS-RunShellScript` only; to let that identity deploy, add
`arn:aws:ssm:*:*:document/AgentDrive-Deploy` to its `RunCommandDocument`
statement.

## What each role can and cannot do

**Release role** `agent-drive-release-us-east-2`, assumable only with GitHub's
OIDC token for a job in the `release` environment of `jssmith/shfs`
(`sub` = `repo:jssmith/shfs:environment:release`, `aud` = `sts.amazonaws.com`),
for at most an hour:

| Can | Resource |
| --- | --- |
| `s3:PutObject`, only with `If-None-Match` | `releases/*` in the artifact bucket |
| `s3:GetObject` | `releases/*` |
| `kms:Sign` (ECDSA_SHA_256), `kms:GetPublicKey`, `kms:Verify` | the release signing key |
| `ssm:SendCommand` | document `AgentDrive-Deploy`, on instances tagged `agent-drive=dev` |
| `ssm:GetCommandInvocation`, `ssm:ListCommandInvocations` | `*` (no resource-level permissions exist) |

It cannot: overwrite or delete a release, list the bucket, run any other SSM
document or any shell of its choosing on the VM, reach untagged instances,
change IAM, KMS or the stack. A job outside the `release` environment cannot assume it.

**VM instance role** `agent-drive-dev-instance-us-east-2`:

| Can | Resource |
| --- | --- |
| `AmazonSSMManagedInstanceCore` (managed policy, unchanged) | Session Manager, Run Command agent |
| `s3:GetObject` | `releases/*` in the artifact bucket |
| `kms:GetPublicKey`, `kms:Verify` | the release signing key |

It cannot: sign, write to the bucket, list it, start builds, send commands,
reach GitHub with any credential (it holds none).

**Signing key** `alias/agent-drive-release-signing` (ECC_NIST_P256, SIGN_VERIFY):
account root administers it; an explicit Deny keeps every principal except the
release role from `kms:Sign`, administrators included. The private key never
leaves KMS.

**Bucket**: versioned, SSE-S3, all public access blocked, ACLs disabled, TLS-only
bucket policy, noncurrent versions expire after 90 days. SSE-S3 rather than
SSE-KMS: releases are built from a public repository and hold no secrets, the
signature provides integrity, and readers need no extra KMS permissions.

## Trust

A tag runs `release.yml` as it is in the tagged commit, so nothing written in
the workflow can be a security boundary: someone with push access could tag a
commit whose workflow skips the checks. The boundary is GitHub's environment
gate. The release job runs in the environment `release`, which requires
Johann's approval (and is limited to `v*` tags), and `ReleaseRole` trusts only
tokens for that environment (`sub` = `repo:jssmith/shfs:environment:release`).
A workflow that leaves the environment out gets no credentials; one that keeps
it waits for the approval. The workflow's own checks (CI, "the tag is on
`main`") guard against mistakes.

The VM accepts only a manifest signed by the KMS key, for the version it was
asked for (a manifest copied from another version's path is refused), and
only an archive whose sha256 is in that manifest. A compromised bucket can
withhold releases but not change one. A compromised VM can read releases
(public code) and verify signatures, nothing more.

## Not covered yet

- ECR for the sandbox image: the VM builds its rootfs from `sandbox/` with
  Docker when provisioning changes. A rollback does not roll the rootfs back.
- The Rust `fs/` daemon is tested by CI but not shipped in releases (not in use by the server yet).
- A ruleset on `v*` tags (who may create them; no moving or deleting).
- Production (`agent-drive=prod`, manual approval) and restricting the VM's
  outbound network.
