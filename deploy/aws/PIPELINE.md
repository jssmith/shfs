# Deployment pipeline

A builder Lambda MicroVM in AWS clones the public repository, tests (gVisor
suites included), and makes signed, versioned releases; the drive VM, which has
no GitHub access and no long-lived secrets, deploys a given release through one
fixed SSM document. Design: `design-agent-drive/docs/deployment-pipeline.md`;
why a MicroVM: decision 0007.

```
push to main ──▶ GitHub webhook ──▶ Lambda agent-drive-build-trigger (function URL)
                   checks X-Hub-Signature-256, keeps pushes to main of jssmith/shfs,
                   │ RunMicrovm agent-drive-builder with {commit} (none if one is building)
                   ▼
                 builder MicroVM (deploy/aws/builder): git clone (public, no token),
                   commit on main? → the commit's deploy/aws/ci.sh test | package | publish
                   │ kms:Sign the manifest's digest → manifest.sig; result → builds/<sha>/
                   │ main moved meanwhile? build the new head; then terminate itself
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
| `pipeline.yaml` | Stack `agent-drive-pipeline`: bucket, signing key, builder roles and logs, webhook secret, trigger function and URL, SSM document |
| `builder/` | The builder MicroVM image: `make-image.sh` (zip with the Dockerfile), `runner.mjs` (hooks), `run.sh` (one build), `prepare.sh` (cgroups for gVisor), `warm.sh` (snapshot prefetch), `sandbox-hash.sh` |
| `trigger/` | The trigger function (`index.mjs`, tested by `index.test.mjs`) and `make-zip.sh` |
| `dev-vm.yaml` | The VM stack; `ReleaseReadPolicy` lets its instance role read releases and the public key |
| `ci.sh` | Build steps: test, package, publish (sign, upload, deploy, wait); run by the builder from the commit being built |
| `deploy-release.sh` | VM-side deploy; embedded verbatim in the document |
| `sync-deploy-document.py` | Copies `deploy-release.sh` into `pipeline.yaml`; run it after changing the script |
| `test/test-deploy-release.sh` | Local test of publish and deploy with stub `aws`, `systemctl`, `curl` and a real P-256 key |
| `test/test-release-smoke.sh` | Packages this checkout, deploys it with stubs, and checks the real server's `/healthz` |
| `test/check-deploy-document.py` | The document takes only a sha, embeds the current script, and parses with `sh -n` |

## A release

`releases/<version>/`, version = the commit sha (`BUILD_SOURCE_VERSION`):

| Object | Contents |
| --- | --- |
| `release.tar.zst` | `package.json`, lockfile, `server/` and `cli/` (`dist`, `package.json`, data files from `src/`), production `node_modules`, `deploy/`, `sandbox/`, `RELEASE` |
| `manifest.json` | `format`, `version`, `source`, `build_id` (the builder MicroVM), `build_arn`, `built_at`, `node_version`, `archive.{name,sha256,size}`, `setup_sha256`, `provision_sha256` |
| `manifest.sig` | ECDSA P-256 signature (DER) by KMS over the SHA-256 digest of `manifest.json` |

Each object is uploaded with `If-None-Match: *`, and the builder role may only make
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

1. **Trigger zip.** `deploy/aws/trigger/make-zip.sh trigger.zip`, upload to
   `s3://<bucket>/builder/trigger-<sha256 prefix>.zip`.
2. **Update the pipeline stack** with `TriggerCodeKey` set to that key. Read the
   change set first: it removes the CodeBuild project, its role and the GitHub
   connection, adds the builder and trigger resources, and modifies the signing
   key's policy (the builder role becomes the only signer). Bucket and key are
   modified, never replaced.
3. **Builder image.** `deploy/aws/builder/make-image.sh builder.zip`, upload to
   `s3://<bucket>/builder/image-<sha256 prefix>.zip`, then `CreateMicrovmImage`
   (first time) or `UpdateMicrovmImage` named `agent-drive-builder`: base
   `al2023-1`, build role `agent-drive-builder-image-us-east-2`,
   `cpuConfigurations` `X86_64`, `resources` 8192 MiB, `additionalOsCapabilities`
   `ALL`, hooks on port 9000 (`ready` 120 s, `validate` 900 s, `run` 5 s),
   logging to `/aws/lambda-microvms/agent-drive-builder`. About 9 minutes. Set
   the stack's `BuilderImageVersion` to the new version.
4. **A first build by hand** (`BuildCommit` output), follow it in
   `/aws/lambda-microvms/agent-drive-builder`; the result lands in
   `s3://<bucket>/builds/<sha>/<microvm>.json`.
5. **Johann adds the webhook on GitHub**: jssmith/shfs > Settings > Webhooks >
   Add webhook. Payload URL: the stack's `WebhookUrl`; content type
   `application/json`; Secret: the value of the Secrets Manager secret
   `agent-drive/github-webhook` (console: Secrets Manager > the secret >
   *Retrieve secret value*); *Just the push event*. GitHub sends a ping, which
   the trigger answers with 200.

Rebuild the builder image (step 3) when `sandbox/` or the toolchain changes:
a commit whose `sandbox/` differs from the image's is tested but not released
(its result says so).

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
statement (and `lambda:InvokeFunction` on `agent-drive-build-trigger` and
`logs:GetLogEvents` on `/aws/lambda-microvms/agent-drive-builder` to start and follow builds).

## What each role can and cannot do

**Builder role** `agent-drive-builder-us-east-2` (the builder MicroVM's execution role):

| Can | Resource |
| --- | --- |
| `logs:CreateLogGroup`, `CreateLogStream`, `PutLogEvents` | log groups `/aws/lambda-microvms/*` |
| `s3:PutObject`, only with `If-None-Match` | `releases/*` in the artifact bucket |
| `s3:GetObject` | `releases/*` |
| `s3:PutObject` | `builds/*` (build results) |
| `kms:Sign` (ECDSA_SHA_256), `kms:GetPublicKey`, `kms:Verify` | the release signing key |
| `ssm:SendCommand` | document `AgentDrive-Deploy`, on instances tagged `agent-drive=dev` |
| `ssm:GetCommandInvocation`, `ssm:ListCommandInvocations` | `*` (no resource-level permissions exist) |
| `lambda:TerminateMicrovm` | `*` (to stop itself when done) |

It cannot: overwrite or delete a release, list the bucket, run any other SSM
document or any shell of its choosing on the VM, reach untagged instances,
change IAM, KMS or the stack, or write to GitHub (it holds no GitHub credential).

**Trigger role** `agent-drive-build-trigger-us-east-2`: read the webhook secret;
`lambda:RunMicrovm`, `lambda:ListMicrovms`; pass the AWS default network
connectors and the builder role. Nothing else.

**Image build role** `agent-drive-builder-image-us-east-2`: read `builder/*` in
the bucket and write logs, while Lambda builds the MicroVM image.

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
builder role from `kms:Sign`, administrators included. The private key never
leaves KMS.

**Bucket**: versioned, SSE-S3, all public access blocked, ACLs disabled, TLS-only
bucket policy, noncurrent versions expire after 90 days. SSE-S3 rather than
SSE-KMS: releases are built from a public repository and hold no secrets, the
signature provides integrity, and readers need no extra KMS permissions.

## Trust

Whoever can push to `main` can deploy to dev: that is the design. The trigger
is public but checks GitHub's signature; even a forged trigger only names a sha:
the builder clones the repository itself and releases only a commit on `main`,
so the worst a forged call can do is start a build of code already on `main`. The VM accepts
only a manifest signed by the KMS key, for the version it was asked for (a
manifest copied from another version's path is refused), and only an archive
whose sha256 is in that manifest. A compromised bucket can withhold releases but
not change one. A compromised VM can read releases (public code) and verify
signatures, nothing more.

## Not covered yet

- ECR for the sandbox image: the VM builds its rootfs from `sandbox/` with
  Docker when provisioning changes. A rollback does not roll the rootfs back.
- The Rust `fs/` daemon is not built, tested or shipped by the builder (not in use by the server).
- OCR tests: Amazon Linux 2023 has no tesseract package, so the builder skips them.
- Commit statuses on GitHub (needs a GitHub App with commit-status write); results are in `builds/` and the logs.
- Production (`agent-drive=prod`, manual approval) and restricting the VM's
  outbound network.
